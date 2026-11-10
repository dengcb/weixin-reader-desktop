//! 本地书封面缓存与后台补齐。
//!
//! 封面来源有二：阅读器打开 EPUB/MOBI 时前端提取（canvas 缩放后的 JPEG
//! data URL，`save_local_book_cover`）；书架加载时后台线程直接从书文件
//! 批量补齐历史书籍（`start_backfill`：EPUB 解 zip 找 cover-image，
//! MOBI 解 EXTH 201/202 封面记录——移植自 foliate-js mobi.js 的解析）。
//! TXT/PDF 无封面，书架回退占位封面。
//!
//! 生命周期：一书一文件（`local-book-covers/<book_id>`，无扩展名，按魔数
//! 回 content-type）；写入经 `local_books::store_cover_if_book_known` 在
//! 仓储锁内复查书记录仍在，书架移除图书时同步清理，封面永不脱离
//! 书记录单独累积（清除阅读历史不清理封面——书架保留）。

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::local_books::LocalBookFormat;

const COVER_DATA_URL_PREFIX: &str = "data:image/jpeg;base64,";
/// 单张封面字节上限（阅读器侧已缩放到 ≤320×480，占位符即超限拒绝）
const COVER_MAX_BYTES: usize = 512 * 1024;
/// 补齐提取时单张封面原图上限：更大的图不缩放无法用，直接放弃
const COVER_SOURCE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// MOBI 单条记录读取上限（防御损坏文件拖垮内存）
const MOBI_RECORD_MAX_BYTES: usize = 16 * 1024 * 1024;

static COVER_BACKFILL_RUNNING: AtomicBool = AtomicBool::new(false);

fn covers_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    crate::local_books::config_dir(app).map(|dir| dir.join("local-book-covers"))
}

fn cover_file<R: Runtime>(app: &AppHandle<R>, book_id: &str) -> Result<PathBuf, String> {
    Ok(covers_dir(app)?.join(book_id))
}

/// 自定义封面（书架右键「修改封面」指定的 JPG）：与自动提取封面同目录，
/// 加 `.custom` 后缀区分，读取时优先于自动提取结果。
fn custom_cover_file<R: Runtime>(app: &AppHandle<R>, book_id: &str) -> Result<PathBuf, String> {
    Ok(covers_dir(app)?.join(format!("{book_id}.custom")))
}

/// 自定义封面大小上限（用户拍板：1MB 以内的 JPG）。
const CUSTOM_COVER_MAX_BYTES: usize = 1_000_000;

pub(crate) fn custom_cover_exists<R: Runtime>(app: &AppHandle<R>, book_id: &str) -> bool {
    custom_cover_file(app, book_id).is_ok_and(|path| path.exists())
}

/// 写入自定义封面（允许覆盖旧值）：只接受 1MB 以内的 JPEG（魔数校验）。
pub(crate) fn write_custom_cover<R: Runtime>(
    app: &AppHandle<R>,
    book_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.len() < 3 || bytes.len() > CUSTOM_COVER_MAX_BYTES {
        return Err("封面图片须为 1MB 以内的 JPG".to_string());
    }
    if bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[2] != 0xFF {
        return Err("所选文件不是有效的 JPG 图片".to_string());
    }
    let path = custom_cover_file(app, book_id)?;
    fs::create_dir_all(covers_dir(app)?).map_err(|error| format!("无法创建封面目录：{error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("无法写入自定义封面：{error}"))
}

pub(crate) fn remove_custom_cover<R: Runtime>(app: &AppHandle<R>, book_id: &str) {
    if let Ok(path) = custom_cover_file(app, book_id) {
        let _ = fs::remove_file(path);
    }
}

/// 书记录删除（书架移除图书）时同步删除封面。
pub(crate) fn remove_cover<R: Runtime>(app: &AppHandle<R>, book_id: &str) {
    if let Ok(path) = cover_file(app, book_id) {
        let _ = fs::remove_file(path);
    }
    remove_custom_cover(app, book_id);
}

/// 落盘封面（调用方须已持仓储锁并校验书记录存在）。已存在即跳过：封面
/// 提取结果视为不变，重复打开不重写。
pub(crate) fn write_cover<R: Runtime>(
    app: &AppHandle<R>,
    book_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > COVER_MAX_BYTES {
        return Err("封面数据大小不合法".to_string());
    }
    let path = cover_file(app, book_id)?;
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(covers_dir(app)?).map_err(|error| format!("无法创建封面目录：{error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("无法写入封面缓存：{error}"))
}

/// 仅接受阅读器缩放后的 JPEG data URL；返回解码后的图片字节。
fn parse_cover_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let payload = data_url
        .strip_prefix(COVER_DATA_URL_PREFIX)
        .ok_or("封面数据格式不受支持")?;
    // base64 膨胀 4/3：限制字符串长度即限制解码后体积
    if payload.len() > 700_000 {
        return Err("封面数据过大".to_string());
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("封面数据解码失败：{error}"))?;
    if bytes.is_empty() || bytes.len() > COVER_MAX_BYTES {
        return Err("封面数据大小不合法".to_string());
    }
    Ok(bytes)
}

/// 本地书封面缓存：阅读器打开 EPUB/MOBI 时提取内嵌封面后调用。
/// 书架页经协议路由 /local-book-cover/<book_id> 读取。
#[tauri::command]
pub fn save_local_book_cover<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    book_id: String,
    data_url: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以保存本地书封面".to_string());
    }
    let bytes = parse_cover_data_url(&data_url)?;
    crate::local_books::store_cover_if_book_known(&app, &book_id, &bytes)
}

/// 协议路由 /local-book-cover/<book_id> 的响应体（主窗口专用，lib.rs 已先
/// 校验 webview label）。记录不存在或无缓存封面时 404，书架页 <img> onerror
/// 回退占位封面；损坏的缓存文件顺带清除实现自愈。
pub fn cover_response<R: Runtime>(
    app: &AppHandle<R>,
    book_id: &str,
) -> tauri::http::Response<Vec<u8>> {
    let not_found = error_response(404, "封面不存在");
    if crate::local_books::validate_book_id(book_id).is_err()
        || !crate::local_books::book_record_exists(app, book_id)
    {
        return not_found;
    }
    // 自定义封面优先（写入时已做 JPEG 魔数校验，这里再嗅探一次防文件被换）
    if let Ok(custom) = custom_cover_file(app, book_id) {
        if let Ok(bytes) = fs::read(&custom) {
            if sniff_image_mime(&bytes).is_some() {
                return response(200, "image/jpeg", bytes);
            }
        }
    }
    let bytes = match cover_file(app, book_id).and_then(|path| {
        fs::read(&path).map_err(|error| format!("无法读取封面缓存：{error}"))
    }) {
        Ok(bytes) => bytes,
        Err(_) => return not_found,
    };
    match sniff_image_mime(&bytes) {
        Some(mime) => response(200, mime, bytes),
        // 缓存内容损坏（历史版本/写坏）：删掉让下次补齐重建
        None => {
            remove_cover(app, book_id);
            not_found
        }
    }
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-store")
        .body(body)
        .expect("valid local cover response")
}

fn error_response(status: u16, message: &str) -> tauri::http::Response<Vec<u8>> {
    response(
        status,
        "application/json; charset=utf-8",
        serde_json::to_vec(&serde_json::json!({ "error": message })).unwrap_or_default(),
    )
}

/// 按魔数识别封面格式（前端路径恒为 JPEG；补齐路径保留原格式）
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// 书架加载时后台补齐历史封面：缺缓存的 EPUB/MOBI 直接从书文件提取，
/// 不要求用户重新打开。完成后 emit `local-book-covers-updated`，书架页
/// 监听后重载。运行中重入直接忽略（下次打开书架自然再试）。
pub fn start_backfill<R: Runtime>(app: &AppHandle<R>) {
    if COVER_BACKFILL_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let updated = run_backfill(&app);
        COVER_BACKFILL_RUNNING.store(false, Ordering::SeqCst);
        if updated {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("local-book-covers-updated", ());
            }
        }
    });
}

fn run_backfill<R: Runtime>(app: &AppHandle<R>) -> bool {
    let books = crate::local_books::list_recent(app);
    let mut updated = false;
    for record in &books {
        // 源文件已丢失的书：记录按设计保留待用户决定（打开时弹窗/管理模式移除），
        // 封面提取无从谈起，静默跳过——否则每次打开书架都重复刷同一条失败告警
        if !record.path.is_file() {
            continue;
        }
        if cover_file(app, &record.book_id).map(|path| path.exists()).unwrap_or(true) {
            continue;
        }
        let extracted = match record.format {
            LocalBookFormat::Epub => extract_epub_cover(&record.path),
            LocalBookFormat::Mobi => extract_mobi_cover(&record.path),
            // TXT/PDF 无内嵌封面
            _ => Ok(None),
        };
        match extracted {
            Ok(Some(bytes)) => {
                // 书记录可能在提取期间被删除：锁内复查，失败即放弃该本
                if crate::local_books::store_cover_if_book_known(app, &record.book_id, &bytes)
                    .is_ok()
                {
                    updated = true;
                }
            }
            Ok(None) => {}
            Err(error) => {
                log::warn!(
                    target: "local-books",
                    "cover_backfill_failed book_id={} format={:?} error={error}",
                    &record.book_id[..8],
                    record.format
                );
            }
        }
    }
    updated
}

/// EPUB 封面：container.xml → OPF → cover-image（EPUB3 properties /
/// EPUB2 meta[name=cover] / 文件名 cover* 兜底）→ 读取图片字节。
fn extract_epub_cover(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = fs::File::open(path).map_err(|error| format!("无法打开 EPUB：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("EPUB 文件损坏：{error}"))?;
    let container = crate::local_books::read_zip_text(&mut archive, "META-INF/container.xml")?;
    let container_doc = crate::local_books::parse_epub_xml(&container)
        .map_err(|error| format!("EPUB container.xml 无效：{error}"))?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .ok_or("EPUB 未声明 package document")?
        .to_string();
    let opf = crate::local_books::read_zip_text(&mut archive, &opf_path)?;
    let opf_doc = crate::local_books::parse_epub_xml(&opf)
        .map_err(|error| format!("EPUB package document 无效：{error}"))?;
    struct CoverItem {
        id: String,
        href: String,
        media_type: String,
        properties: Option<String>,
    }
    let mut items = Vec::new();
    for node in opf_doc.descendants().filter(|node| {
        node.is_element() && node.tag_name().name() == "item" && node.attribute("id").is_some()
    }) {
        let Some(href) = node.attribute("href") else { continue };
        let Ok(href) = crate::local_books::resolve_epub_href(&opf_path, href) else {
            continue;
        };
        items.push(CoverItem {
            id: node.attribute("id").unwrap_or_default().to_string(),
            href,
            media_type: node.attribute("media-type").unwrap_or_default().to_string(),
            properties: node.attribute("properties").map(str::to_string),
        });
    }
    let meta_cover_id = opf_doc
        .descendants()
        .find(|node| {
            node.is_element()
                && node.tag_name().name() == "meta"
                && node.attribute("name") == Some("cover")
        })
        .and_then(|node| node.attribute("content"))
        .map(str::to_string);
    let declared = items
        .iter()
        .find(|item| {
            item.properties
                .as_deref()
                .is_some_and(|values| values.split_whitespace().any(|value| value == "cover-image"))
        })
        .or_else(|| {
            let id = meta_cover_id.as_deref()?;
            items.iter().find(|item| item.id == id)
        });
    let fallback = items.iter().find(|item| {
        item.media_type.starts_with("image/")
            && item
                .href
                .rsplit('/')
                .next()
                .is_some_and(|name| name.to_lowercase().starts_with("cover"))
    });
    let Some(href) = declared.or(fallback).map(|item| item.href.clone()) else {
        return Ok(None);
    };
    let bytes = read_zip_image(&mut archive, &href)?;
    Ok(sniff_image_mime(&bytes).map(|_| bytes))
}

fn read_zip_image(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Vec<u8>, String> {
    crate::local_books::validate_epub_entry_name(name)?;
    // 先解析出条目下标再统一读取，避免 ZipFile 对 archive 的可变借用跨段。
    // 主路径按条目原名匹配；个别 EPUB 的 zip 条目名保留原始百分号编码，
    // 与解码后的 href 不一致，逐条目按解码名兜底。
    let mut resolved: Option<usize> = None;
    for index in 0..archive.len() {
        let candidate = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 EPUB 目录：{error}"))?;
        let decoded = percent_encoding::percent_decode_str(candidate.name())
            .decode_utf8()
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| candidate.name().to_string());
        if candidate.name() == name || decoded == name {
            resolved = Some(index);
            break;
        }
    }
    let index = resolved.ok_or(format!("EPUB 封面条目不存在：{name}"))?;
    let mut entry = archive
        .by_index(index)
        .map_err(|error| format!("无法读取 EPUB 条目：{error}"))?;
    if entry.size() > COVER_SOURCE_MAX_BYTES as u64 {
        return Err("EPUB 封面条目过大".to_string());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 EPUB 封面：{error}"))?;
    Ok(bytes)
}

/// MOBI/AZW3 封面：PDB 记录表 → record0（PalmDOC+MOBI 头）→ EXTH 201/202 →
/// resourceStart+offset 号记录的原图字节。与 foliate-js mobi.js 的 getCover
/// 语义一致（含 KF8 组合包跳 boundary）。
fn extract_mobi_cover(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("无法打开 MOBI：{error}"))?;
    let file_len = file.metadata().map_err(|error| format!("无法读取 MOBI 信息：{error}"))?.len();
    let mut pdb = [0u8; 78];
    file.read_exact(&mut pdb).map_err(|error| format!("MOBI 头不完整：{error}"))?;
    let num_records = u16::from_be_bytes([pdb[76], pdb[77]]) as usize;
    if num_records == 0 {
        return Ok(None);
    }
    let mut index_bytes = vec![0u8; num_records * 8];
    file.read_exact(&mut index_bytes)
        .map_err(|error| format!("MOBI 记录表不完整：{error}"))?;
    let starts: Vec<u64> = (0..num_records)
        .map(|index| {
            u32::from_be_bytes([
                index_bytes[index * 8],
                index_bytes[index * 8 + 1],
                index_bytes[index * 8 + 2],
                index_bytes[index * 8 + 3],
            ]) as u64
        })
        .collect();

    let mut read_record = |index: usize| -> Option<Vec<u8>> {
        let start = *starts.get(index)?;
        let end = starts.get(index + 1).copied().unwrap_or(file_len);
        if end <= start || end - start > MOBI_RECORD_MAX_BYTES as u64 {
            return None;
        }
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut record = vec![0u8; (end - start) as usize];
        file.read_exact(&mut record).ok()?;
        Some(record)
    };

    // KF8 组合包：version < 8 且 EXTH 121 boundary 有效时，头部以 KF8 段为准
    let mut header = parse_mobi_record0(&read_record(0).ok_or("MOBI record0 缺失")?)
        .ok_or("MOBI record0 无法解析")?;
    if header.version < 8 {
        if let Some(boundary) = header.exth.boundary {
            if (boundary as usize) < num_records {
                if let Some(record) = read_record(boundary as usize) {
                    if let Some(kf8) = parse_mobi_record0(&record) {
                        header = kf8;
                    }
                }
            }
        }
    }
    if header.encryption != 0 {
        // DRM 图书不提取封面
        return Ok(None);
    }
    let offset = match header.exth.cover_offset.or(header.exth.thumbnail_offset) {
        Some(value) if value != 0xffff_ffff => value,
        _ => return Ok(None),
    };
    let Some(index) = header.resource_start.checked_add(offset) else {
        return Ok(None);
    };
    let Some(image) = read_record(index as usize) else {
        return Ok(None);
    };
    Ok(sniff_image_mime(&image).map(|_| image))
}

#[derive(Default, Clone, Copy)]
struct ExthOffsets {
    boundary: Option<u32>,
    cover_offset: Option<u32>,
    thumbnail_offset: Option<u32>,
}

struct MobiHeader {
    encryption: u16,
    version: u32,
    resource_start: u32,
    exth: ExthOffsets,
}

fn be_u16(bytes: &[u8], at: usize) -> Option<u16> {
    bytes.get(at..at + 2).map(|value| u16::from_be_bytes([value[0], value[1]]))
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .map(|value| u32::from_be_bytes([value[0], value[1], value[2], value[3]]))
}

/// record0 布局：PalmDOC 头 16 字节 + MOBI 头（magic@16、length@20、
/// version@36、resourceStart@108、exthFlag@128）+ 可选 EXTH（16+length 起）
fn parse_mobi_record0(record: &[u8]) -> Option<MobiHeader> {
    if record.get(16..20) != Some(b"MOBI") {
        return None;
    }
    let mobi_length = be_u32(record, 20)? as usize;
    let exth_flag = be_u32(record, 128)?;
    let exth = if exth_flag & 0x40 != 0 {
        parse_exth(record, 16 + mobi_length)
    } else {
        None
    }
    .unwrap_or_default();
    Some(MobiHeader {
        encryption: be_u16(record, 12)?,
        version: be_u32(record, 36)?,
        resource_start: be_u32(record, 108)?,
        exth,
    })
}

fn parse_exth(record: &[u8], start: usize) -> Option<ExthOffsets> {
    if record.get(start..start + 4) != Some(b"EXTH") {
        return None;
    }
    let count = be_u32(record, start + 8)? as usize;
    let mut offsets = ExthOffsets::default();
    let mut pos = start + 12;
    for _ in 0..count {
        let record_type = be_u32(record, pos)?;
        let length = be_u32(record, pos + 4)? as usize;
        if length < 8 {
            return None;
        }
        let value = be_u32(record, pos + 8);
        match record_type {
            121 => offsets.boundary = value,
            201 => offsets.cover_offset = value,
            202 => offsets.thumbnail_offset = value,
            _ => {}
        }
        pos += length;
    }
    Some(offsets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn be32(value: u32) -> [u8; 4] {
        value.to_be_bytes()
    }

    fn push_u32(buf: &mut Vec<u8>, at: usize, value: u32) {
        buf[at..at + 4].copy_from_slice(&be32(value));
    }

    #[test]
    fn sniff_image_mime_recognizes_supported_formats_only() {
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(sniff_image_mime(b"GIF89a..."), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"<html>"), None);
        assert_eq!(sniff_image_mime(&[]), None);
    }

    #[test]
    fn cover_data_url_accepts_only_bounded_jpeg_payloads() {
        use base64::Engine as _;
        let encode = |bytes: &[u8]| {
            format!(
                "{COVER_DATA_URL_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        };
        let decoded = parse_cover_data_url(&encode(&[0xFF, 0xD8, 0xFF, 0xE0])).unwrap();
        assert_eq!(decoded, vec![0xFF, 0xD8, 0xFF, 0xE0]);

        // 非 JPEG data URL 前缀一律拒绝（PNG 等格式都不放行）
        assert!(parse_cover_data_url("data:image/png;base64,aGVsbG8=").is_err());
        assert!(parse_cover_data_url("data:image/jpeg;webp,aGVsbG8=").is_err());
        assert!(parse_cover_data_url("aGVsbG8=").is_err());
        assert!(parse_cover_data_url("").is_err());

        // 非法 base64 / 超长 / 解码为空都拒绝
        assert!(parse_cover_data_url("data:image/jpeg;base64,@@@@").is_err());
        let oversized = format!("{COVER_DATA_URL_PREFIX}{}", "A".repeat(700_001));
        assert!(parse_cover_data_url(&oversized).is_err());
        let empty_payload = parse_cover_data_url(COVER_DATA_URL_PREFIX).unwrap_err();
        assert!(empty_payload.contains("大小不合法"), "{empty_payload}");
    }

    fn build_mobi(version: u32, encryption: u16, cover_offset: Option<u32>) -> PathBuf {
        // 记录表(94 字节) + record0 = PalmDOC 头(16) + MOBI 头(248) + EXTH 头(12) + 3 条记录(36)
        let mut record0 = vec![0u8; 16 + 248 + 12 + 12 * 3];
        record0[0..2].copy_from_slice(&1u16.to_be_bytes()); // compression = none
        record0[12..14].copy_from_slice(&encryption.to_be_bytes());
        record0[16..20].copy_from_slice(b"MOBI");
        push_u32(&mut record0, 20, 248); // mobi header length
        push_u32(&mut record0, 36, version);
        push_u32(&mut record0, 108, 1); // resourceStart
        push_u32(&mut record0, 128, 0x40); // exthFlag: EXTH present
        let exth_at = 16 + 248;
        record0[exth_at..exth_at + 4].copy_from_slice(b"EXTH");
        push_u32(&mut record0, exth_at + 4, 48); // EXTH 总长（头 12 + 3 条记录）
        push_u32(&mut record0, exth_at + 8, 3); // record count
        let mut record_at = exth_at + 12;
        let mut push_exth = |record_type: u32, value: u32| {
            push_u32(&mut record0, record_at, record_type);
            push_u32(&mut record0, record_at + 4, 12);
            push_u32(&mut record0, record_at + 8, value);
            record_at += 12;
        };
        push_exth(121, 0xffff_ffff); // boundary: 无 KF8 段
        push_exth(201, cover_offset.unwrap_or(0xffff_ffff));
        push_exth(202, 0xffff_ffff); // thumbnail: 无

        let image = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x11, 0x22];
        let start0: u64 = 94; // PDB 头 78 + 记录表 2×8
        let start1: u64 = start0 + record0.len() as u64;
        let mut out = vec![0u8; start0 as usize];
        out[76..78].copy_from_slice(&2u16.to_be_bytes()); // numRecords
        for (index, offset) in [start0, start1].into_iter().enumerate() {
            let at = 78 + index * 8;
            out[at..at + 4].copy_from_slice(&(offset as u32).to_be_bytes());
        }
        out.extend_from_slice(&record0);
        out.extend_from_slice(&image);
        let path = std::env::temp_dir().join(format!(
            "atreader-cover-test-{}-{}.mobi",
            std::process::id(),
            NAME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::write(&path, out).unwrap();
        path
    }

    /// 测试并行运行时临时文件名必须互不相同
    static NAME_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    #[test]
    fn mobi_cover_extracts_exth_201_record() {
        let path = build_mobi(6, 0, Some(0));
        let extracted = extract_mobi_cover(&path).unwrap().unwrap();
        assert_eq!(extracted, vec![0xFF, 0xD8, 0xFF, 0xE0, 0x11, 0x22]);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn mobi_cover_falls_back_to_thumbnail_and_rejects_drm() {
        // EXTH 201 缺席 → 回退 202（本构造里也是 0xffff_ffff → None）
        let no_cover = build_mobi(6, 0, None);
        assert!(extract_mobi_cover(&no_cover).unwrap().is_none());
        std::fs::remove_file(no_cover).unwrap();

        // DRM（encryption != 0）不提取
        let drm = build_mobi(6, 1, Some(0));
        assert!(extract_mobi_cover(&drm).unwrap().is_none());
        std::fs::remove_file(drm).unwrap();
    }
}
