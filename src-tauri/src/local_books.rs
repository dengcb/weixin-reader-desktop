use encoding_rs::GB18030;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const HISTORY_VERSION: u64 = 1;
const MAX_RECENT_BOOKS: usize = 10;
const MAX_PROTOCOL_ENTRY_SIZE: u64 = 128 * 1024 * 1024;
const MAX_TXT_FILE_SIZE: u64 = 256 * 1024 * 1024;
const MAX_MOBI_FILE_SIZE: u64 = 128 * 1024 * 1024;
const MAX_PDF_FILE_SIZE: u64 = 128 * 1024 * 1024;
const MAX_EPUB_ENTRIES: usize = 20_000;
const MAX_EPUB_TOTAL_SIZE: u64 = 2 * 1024 * 1024 * 1024;
const LOCAL_READER_HTML: &[u8] = include_bytes!("../../src/windows/local-reader.html");
const LOCAL_READER_JS: &[u8] = include_bytes!("../../src/scripts/local_reader.js");
const LOCAL_READER_BOOTSTRAP_JS: &[u8] =
    include_bytes!("../../src/scripts/local_reader_bootstrap.js");
const LOCAL_READER_CSS: &[u8] = include_bytes!("../../src/windows/local-reader.css");
const FOLIATE_LICENSE: &[u8] = include_bytes!("../../third-party/foliate-js/LICENSE");
const THIRD_PARTY_NOTICES: &[u8] = include_bytes!("../../THIRD-PARTY-NOTICES.md");

static LOCAL_BOOKS_LOCK: Mutex<()> = Mutex::new(());
static STARTUP_NOTICE: Mutex<Option<String>> = Mutex::new(None);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
// macOS 冷启动时 Opened 事件可能先于主窗口 setup 到达，先暂存路径。
static PENDING_OPEN_BOOK: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalBookFormat {
    Txt,
    Epub,
    Mobi,
    Pdf,
}

impl LocalBookFormat {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Epub => "epub",
            Self::Mobi => "mobi",
            Self::Pdf => "pdf",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBookRecord {
    pub book_id: String,
    pub path: PathBuf,
    pub format: LocalBookFormat,
    pub title: String,
    pub file_size: u64,
    pub modified_at: u64,
    pub last_opened_at: u64,
    #[serde(default)]
    pub fixed_layout: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBookPublic {
    pub book_id: String,
    pub format: LocalBookFormat,
    pub title: String,
    pub file_size: u64,
    pub modified_at: u64,
    pub last_opened_at: u64,
    pub fixed_layout: bool,
}

impl From<&LocalBookRecord> for LocalBookPublic {
    fn from(value: &LocalBookRecord) -> Self {
        Self {
            book_id: value.book_id.clone(),
            format: value.format.clone(),
            title: value.title.clone(),
            file_size: value.file_size,
            modified_at: value.modified_at,
            last_opened_at: value.last_opened_at,
            fixed_layout: value.fixed_layout,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBooksDocument {
    version: u64,
    books: Vec<LocalBookRecord>,
}

impl Default for LocalBooksDocument {
    fn default() -> Self {
        Self {
            version: HISTORY_VERSION,
            books: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpubEntryInfo {
    name: String,
    size: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))
}

fn history_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("local-books.json"))
}

fn progress_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("local-reading-progress"))
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("local-book-cache"))
}

fn validate_book_id(book_id: &str) -> Result<(), String> {
    if book_id.len() != 64 || !book_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("无效的本地图书 ID".to_string());
    }
    Ok(())
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(source, target).map_err(|error| format!("无法替换本地图书数据：{error}"))
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
        source_wide.push(0);
        let mut target_wide: Vec<u16> = target.as_os_str().encode_wide().collect();
        target_wide.push(0);
        let result = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            Err(format!(
                "无法替换本地图书数据：{}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("本地图书数据路径无父目录")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".local-books.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let result: Result<(), String> = (|| {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建临时数据文件：{error}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, value)
            .map_err(|error| format!("无法序列化本地图书数据：{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("无法刷新本地图书数据：{error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("无法同步本地图书数据：{error}"))?;
        drop(writer);
        replace_file(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("无法同步配置目录：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_document(path: &Path) -> LocalBooksDocument {
    File::open(path)
        .ok()
        .and_then(|file| serde_json::from_reader(BufReader::new(file)).ok())
        .filter(|document: &LocalBooksDocument| document.version == HISTORY_VERSION)
        .unwrap_or_default()
}

fn with_document<R: Runtime, T>(
    app: &AppHandle<R>,
    operation: impl FnOnce(&mut LocalBooksDocument) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let _guard = LOCAL_BOOKS_LOCK
        .lock()
        .map_err(|_| "本地图书仓储锁已损坏".to_string())?;
    let path = history_path(app)?;
    let mut document = read_document(&path);
    let (result, changed) = operation(&mut document)?;
    if changed {
        let evicted = sort_and_truncate(&mut document);
        atomic_write_json(&path, &document)?;
        for record in evicted {
            remove_book_data(app, &record.book_id);
        }
    }
    Ok(result)
}

fn sort_and_truncate(document: &mut LocalBooksDocument) -> Vec<LocalBookRecord> {
    document
        .books
        .sort_by_key(|book| std::cmp::Reverse(book.last_opened_at));
    if document.books.len() <= MAX_RECENT_BOOKS {
        return Vec::new();
    }
    document.books.split_off(MAX_RECENT_BOOKS)
}

pub fn list_recent<R: Runtime>(app: &AppHandle<R>) -> Vec<LocalBookRecord> {
    with_document(app, |document| Ok((document.books.clone(), false))).unwrap_or_default()
}

fn remove_book_data<R: Runtime>(app: &AppHandle<R>, book_id: &str) {
    if let Ok(progress) = progress_dir(app) {
        let _ = fs::remove_file(progress.join(format!("{book_id}.json")));
    }
    if let Ok(cache_root) = cache_dir(app) {
        let cache = cache_root.join(book_id);
        if cache.exists() {
            let _ = fs::remove_dir_all(cache);
        }
    }
}

fn find_record<R: Runtime>(app: &AppHandle<R>, book_id: &str) -> Result<LocalBookRecord, String> {
    let _guard = LOCAL_BOOKS_LOCK
        .lock()
        .map_err(|_| "本地图书仓储锁已损坏".to_string())?;
    find_record_locked(app, book_id)
}

fn find_record_locked<R: Runtime>(
    app: &AppHandle<R>,
    book_id: &str,
) -> Result<LocalBookRecord, String> {
    validate_book_id(book_id)?;
    let path = history_path(app)?;
    let mut document = read_document(&path);
    let record = document
        .books
        .iter()
        .find(|book| book.book_id == book_id)
        .cloned()
        .ok_or_else(|| "本地图书记录不存在".to_string())?;
    match fs::metadata(&record.path) {
        Ok(metadata) if metadata.is_file() => Ok(record),
        Ok(_) => Err("本地图书路径不是文件".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            document.books.retain(|book| book.book_id != book_id);
            atomic_write_json(&path, &document)?;
            remove_book_data(app, book_id);
            Err(format!("MISSING:{}", record.title))
        }
        Err(error) => Err(format!("无法读取《{}》：{error}", record.title)),
    }
}

fn read_zip_text(archive: &mut zip::ZipArchive<File>, name: &str) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|error| format!("EPUB 缺少 {name}：{error}"))?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|error| format!("无法读取 EPUB 条目 {name}：{error}"))?;
    Ok(text)
}

fn resolve_epub_href(opf_path: &str, href: &str) -> Result<String, String> {
    let without_fragment = href.split_once('#').map_or(href, |(path, _)| path);
    let href = without_fragment
        .split_once('?')
        .map_or(without_fragment, |(path, _)| path);
    let decoded = percent_decode_str(href)
        .decode_utf8()
        .map_err(|_| "EPUB manifest 含有无效 URL 编码".to_string())?;
    if decoded.is_empty() || decoded.contains('\0') || decoded.contains('\\') {
        return Err("EPUB manifest 含有无效资源路径".to_string());
    }
    if decoded
        .split('/')
        .next()
        .is_some_and(|first| first.contains(':'))
    {
        return Err("EPUB spine 不支持外部资源".to_string());
    }
    let mut parts = opf_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    parts.pop();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("EPUB manifest 资源越过归档根目录".to_string());
                }
            }
            value => parts.push(value),
        }
    }
    let resolved = parts.join("/");
    validate_epub_entry_name(&resolved)?;
    Ok(resolved)
}

/// Parse the XML documents embedded in an EPUB package.
///
/// A large number of otherwise valid EPUB XHTML files contain the standard
/// `<!DOCTYPE ...>` declaration. `roxmltree::Document::parse` rejects every
/// DTD by default, which made those books fail during our preflight even
/// though the reader itself can render them. Allowing the declaration keeps
/// the XML well-formedness check while `roxmltree` still does not fetch
/// external resources and keeps its entity-expansion loop protections.
fn parse_epub_xml(markup: &str) -> Result<roxmltree::Document<'_>, roxmltree::Error> {
    roxmltree::Document::parse_with_options(
        markup,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..roxmltree::ParsingOptions::default()
        },
    )
}

fn validate_spine_entry(
    archive: &mut zip::ZipArchive<File>,
    path: &str,
    media_type: &str,
) -> Result<(), String> {
    let mut entry = archive
        .by_name(path)
        .map_err(|_| format!("EPUB spine 资源不存在：{path}"))?;
    if entry.is_dir() || entry.size() == 0 {
        return Err(format!("EPUB spine 资源为空：{path}"));
    }
    match media_type {
        "application/xhtml+xml" | "image/svg+xml" => {
            let mut markup = String::new();
            entry
                .read_to_string(&mut markup)
                .map_err(|error| format!("无法读取 EPUB spine 资源 {path}：{error}"))?;
            let document = parse_epub_xml(&markup)
                .map_err(|error| format!("EPUB spine XML 无效 {path}：{error}"))?;
            if media_type == "image/svg+xml" && document.root_element().tag_name().name() != "svg" {
                return Err(format!("EPUB SVG spine 根元素无效：{path}"));
            }
        }
        "text/html" => {
            let mut markup = String::new();
            entry
                .read_to_string(&mut markup)
                .map_err(|error| format!("无法读取 EPUB HTML spine 资源 {path}：{error}"))?;
            if markup.trim().is_empty() {
                return Err(format!("EPUB HTML spine 资源为空：{path}"));
            }
        }
        value if value.starts_with("image/") => {}
        _ => return Err(format!("EPUB spine 使用不支持的媒体类型：{media_type}")),
    }
    Ok(())
}

fn parse_epub(path: &Path) -> Result<(String, bool), String> {
    log::info!(target: "local-books", "epub_parse_start");
    let result = parse_epub_inner(path);
    if let Err(error) = &result {
        log::warn!(target: "local-books", "epub_parse_failed error={error}");
        log::warn!(target: "frontend", "[LocalBooks] epub_parse_failed error={error}");
    } else {
        log::info!(target: "local-books", "epub_parse_succeeded");
    }
    result
}

fn parse_epub_inner(path: &Path) -> Result<(String, bool), String> {
    let file = File::open(path).map_err(|error| format!("无法打开 EPUB：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("EPUB 文件损坏：{error}"))?;
    validate_archive_bounds(&mut archive)?;
    let container = read_zip_text(&mut archive, "META-INF/container.xml")?;
    let container_doc =
        parse_epub_xml(&container).map_err(|error| format!("EPUB container.xml 无效：{error}"))?;
    let rootfile = container_doc
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")
        .ok_or("EPUB 未声明 package document")?;
    if rootfile
        .attribute("media-type")
        .is_some_and(|value| value != "application/oebps-package+xml")
    {
        return Err("EPUB package document 类型无效".to_string());
    }
    let opf_path = rootfile
        .attribute("full-path")
        .ok_or("EPUB 未声明 package document")?
        .to_string();
    validate_epub_entry_name(&opf_path)?;
    let opf = read_zip_text(&mut archive, &opf_path)?;
    let opf_doc =
        parse_epub_xml(&opf).map_err(|error| format!("EPUB package document 无效：{error}"))?;
    let title = opf_doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "title")
        .and_then(|node| node.text())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    let fixed_layout = opf_doc.descendants().any(|node| {
        node.is_element()
            && node.tag_name().name() == "meta"
            && ((node.attribute("property") == Some("rendition:layout")
                && node
                    .text()
                    .is_some_and(|value| value.trim() == "pre-paginated"))
                || (node.attribute("name") == Some("fixed-layout")
                    && node.attribute("content") == Some("true")))
    });
    let manifest = opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "item")
        .map(|node| {
            let id = node.attribute("id").ok_or("EPUB manifest item 缺少 id")?;
            let href = node
                .attribute("href")
                .ok_or("EPUB manifest item 缺少 href")?;
            let media_type = node
                .attribute("media-type")
                .ok_or("EPUB manifest item 缺少 media-type")?;
            Ok((
                id.to_string(),
                (resolve_epub_href(&opf_path, href)?, media_type.to_string()),
            ))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;
    let spine = opf_doc
        .descendants()
        .filter(|node| {
            node.is_element()
                && node.tag_name().name() == "itemref"
                && node.attribute("linear") != Some("no")
        })
        .map(|node| {
            node.attribute("idref")
                .map(str::to_string)
                .ok_or_else(|| "EPUB spine itemref 缺少 idref".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if spine.is_empty() {
        return Err("EPUB 没有可阅读的 spine 内容".to_string());
    }
    for idref in spine {
        let (entry_path, media_type) = manifest
            .get(&idref)
            .ok_or_else(|| format!("EPUB spine 引用了不存在的 manifest item：{idref}"))?;
        validate_spine_entry(&mut archive, entry_path, media_type)?;
    }
    if let Ok(encryption) = read_zip_text(&mut archive, "META-INF/encryption.xml") {
        let allowed = [
            "http://www.idpf.org/2008/embedding",
            "http://ns.adobe.com/pdf/enc#RC",
        ];
        let encryption_doc = parse_epub_xml(&encryption)
            .map_err(|error| format!("EPUB encryption.xml 无效：{error}"))?;
        let methods = encryption_doc
            .descendants()
            .filter(|node| node.is_element() && node.tag_name().name() == "EncryptionMethod")
            .collect::<Vec<_>>();
        let unsupported = methods.is_empty()
            || methods.iter().any(|node| {
                node.attribute("Algorithm")
                    .is_none_or(|algorithm| !allowed.contains(&algorithm))
            });
        if unsupported {
            return Err("暂不支持受 DRM 保护的 EPUB".to_string());
        }
    }
    Ok((title, fixed_layout))
}

fn be_u16(bytes: &[u8]) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.try_into().ok()?))
}

fn be_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

/// MOBI 导入只读取文件头部：校验 PDB/MOBI 魔数、拒绝 DRM、抽取书名；
/// 章节解析全部留给前端 mobi.js（与 EPUB 的 Rust 预解析职责对齐）。
fn parse_mobi(path: &Path) -> Result<String, String> {
    let result = parse_mobi_inner(path);
    if let Err(error) = &result {
        log::warn!(target: "local-books", "mobi_parse_failed error={error}");
        log::warn!(target: "frontend", "[LocalBooks] mobi_parse_failed error={error}");
    } else {
        log::info!(target: "local-books", "mobi_parse_succeeded");
    }
    result
}

fn parse_mobi_inner(path: &Path) -> Result<String, String> {
    const MOBI_HEAD_LIMIT: u64 = 64 * 1024;
    let mut file = File::open(path).map_err(|error| format!("无法打开 MOBI：{error}"))?;
    let file_len = file.metadata().map_err(|error| format!("无法读取 MOBI 文件信息：{error}"))?.len();
    let mut pdb = vec![0u8; 78];
    file.read_exact(&mut pdb)
        .map_err(|error| format!("MOBI 文件损坏：{error}"))?;
    if &pdb[60..68] != b"BOOKMOBI" {
        return Err("不是有效的 MOBI/AZW3 文件".to_string());
    }
    let num_records = usize::from(be_u16(&pdb[76..78]).unwrap_or(0));
    if num_records == 0 {
        return Err("MOBI 文件损坏：没有数据记录".to_string());
    }
    let mut offsets = vec![0u8; num_records * 8];
    file.read_exact(&mut offsets)
        .map_err(|error| format!("MOBI 文件损坏：{error}"))?;
    let record0_offset = u64::from(be_u32(&offsets[0..4]).unwrap_or(0));
    let record_end = if num_records > 1 {
        u64::from(be_u32(&offsets[8..12]).unwrap_or(0))
    } else {
        file_len
    };
    if record0_offset >= record_end || record_end > file_len {
        return Err("MOBI 文件损坏：记录表无效".to_string());
    }
    // 记录 0 = PalmDOC/MOBI 头 + EXTH + 内嵌标题，极端情况可超过一页；
    // 只读头部窗口，越界字段一律走书名回退而不是报错。
    let head_len = (record_end - record0_offset).min(MOBI_HEAD_LIMIT) as usize;
    file.seek(SeekFrom::Start(record0_offset))
        .map_err(|error| format!("无法读取 MOBI：{error}"))?;
    let mut record0 = vec![0u8; head_len];
    file.read_exact(&mut record0)
        .map_err(|error| format!("MOBI 文件损坏：{error}"))?;
    if record0.len() < 100 || &record0[16..20] != b"MOBI" {
        return Err("不是有效的 MOBI/AZW3 文件".to_string());
    }
    let encryption = be_u16(&record0[12..14]).unwrap_or(0);
    if encryption != 0 {
        return Err("暂不支持受 DRM 保护的 MOBI/AZW3".to_string());
    }
    // 书名：优先 MOBI 头内嵌标题（titleOffset 相对记录 0 起点），
    // 其次 PDB 头名称（前 32 字节 NUL 结尾），都没有则空串由调用方回退文件名。
    let decode = |bytes: &[u8]| -> String {
        let trimmed = bytes.split(|byte| *byte == 0).next().unwrap_or(bytes);
        if be_u32(&record0[28..32]) == Some(65001) {
            String::from_utf8_lossy(trimmed).trim().to_string()
        } else {
            encoding_rs::WINDOWS_1252.decode(trimmed).0.trim().to_string()
        }
    };
    let title_offset = be_u32(&record0[84..88]).unwrap_or(0) as usize;
    let title_length = be_u32(&record0[88..92]).unwrap_or(0) as usize;
    let title = record0
        .get(title_offset..title_offset.saturating_add(title_length))
        .map(decode)
        .unwrap_or_default();
    if !title.is_empty() {
        return Ok(title);
    }
    Ok(decode(&pdb[0..32]))
}

/// CJK 部首补充区（U+2E80..=U+2EFF）无 Unicode 兼容分解的简化部首 →
/// 统一表意文字显式映射（名称对照 Unicode NamesList，如 ⻓ C-SIMPLIFIED
/// LONG → 长）。繁体形态部首（⻑⻒⻇ 等）不映射：应用面向简体中文，
/// 且这些字形独立成字时几乎不出现。
fn radical_supplement_char(c: char) -> Option<char> {
    Some(match c {
        '\u{2E9F}' => '母', // ⺟
        '\u{2EB0}' => '纟', // ⺰
        '\u{2EC5}' => '见', // ⻅
        '\u{2EC6}' => '角', // ⻆
        '\u{2EC8}' => '讠', // ⻈
        '\u{2EC9}' => '贝', // ⻉
        '\u{2ECC}' => '辶', // ⻌
        '\u{2ED0}' => '钅', // ⻐
        '\u{2ED3}' => '长', // ⻓
        '\u{2ED4}' => '门', // ⻔
        '\u{2ED9}' => '韦', // ⻙
        '\u{2EDA}' => '页', // ⻚
        '\u{2EDB}' => '风', // ⻛
        '\u{2EDC}' => '飞', // ⻜
        '\u{2EE0}' => '饣', // ⻠
        '\u{2EE2}' => '马', // ⻢
        '\u{2EE5}' => '鱼', // ⻥
        '\u{2EE6}' => '鸟', // ⻦
        '\u{2EE7}' => '卤', // ⻧
        '\u{2EE8}' => '麦', // ⻨
        '\u{2EE9}' => '黄', // ⻩
        '\u{2EEA}' => '黾', // ⻪
        '\u{2EEC}' => '齐', // ⻬
        '\u{2EEE}' => '齿', // ⻮
        '\u{2EF0}' => '龙', // ⻰
        '\u{2EF3}' => '龟', // ⻳
        _ => return None,
    })
}

/// 打印管线（Chrome/Skia 等）常把与部首同形的汉字落在康熙部首区
/// （U+2F00..=U+2FD5，「⼀」而非「一」）或部首补充区（⻓⻔⻢等简化部
/// 首形）。字形无异但破坏「第X章」切分与全文搜索。康熙区逐字符 NFKC
/// 归一（该区 214 码位全部有兼容分解），补充区查显式映射表；NFKC 全局
/// 应用会把全角标点半角化，故绝不整串使用。
fn normalize_pdf_text(text: String) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.chars()
        .map(|c| {
            if ('\u{2F00}'..='\u{2FD5}').contains(&c) {
                String::from(c).nfkc().collect::<String>()
            } else {
                radical_supplement_char(c).map(String::from).unwrap_or_else(|| c.to_string())
            }
        })
        .collect()
}

/// PDF 文本缓存：导入打开时提取一次，之后 /text 端点完全复用 TXT 阅读管线
/// （章节切分、进度、排版）。缓存以源文件 mtime 判定新鲜度。空文本（扫描
/// 版/纯图片）与加密文件给出友好错误；pdf-extract 对畸形文件可能 panic
/// （第三方解析器，不受我们控制），catch_unwind 兜底转成打开失败。
fn extract_pdf_text<R: Runtime>(
    app: &AppHandle<R>,
    record: &LocalBookRecord,
) -> Result<PathBuf, String> {
    let cache = cache_dir(app)?.join(format!("pdf-{}.txt", record.book_id));
    let cache_current = fs::metadata(&cache)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .zip(fs::metadata(&record.path).ok().and_then(|meta| meta.modified().ok()))
        .is_some_and(|(cached_at, source_at)| cached_at >= source_at);
    if cache_current {
        return Ok(cache);
    }
    let started = std::time::Instant::now();
    let result = std::panic::catch_unwind(|| pdf_extract::extract_text_by_pages(&record.path));
    let pages = result
        .map_err(|_| "PDF 解析失败，文件可能已损坏或不受支持".to_string())?
        .map_err(|error| {
            log::warn!(target: "local-books", "pdf_extract_failed book_id={} error={error}", record.book_id);
            log::warn!(target: "frontend", "[LocalBooks] pdf_extract_failed book_id={} error={error}", record.book_id);
            if error.to_string().contains("assword") {
                "暂不支持带密码的 PDF".to_string()
            } else {
                format!("PDF 解析失败：{error}")
            }
        })?;
    let page_count = pages.len();
    let text = normalize_pdf_text(
        pages
            .into_iter()
            .map(|page| page.trim().to_string())
            .collect::<Vec<_>>()
            .join("\n\n"),
    );
    if text.trim().is_empty() {
        return Err("PDF 没有可提取的文字，可能是扫描版或纯图片 PDF".to_string());
    }
    let temporary = cache.with_extension("txt.part");
    // clear_local_history 会整个删除缓存目录，写入前先确保存在
    if let Some(parent) = cache.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 PDF 缓存目录：{error}"))?;
    }
    fs::write(&temporary, &text).map_err(|error| format!("无法写入 PDF 文本缓存：{error}"))?;
    replace_file(&temporary, &cache)?;
    log::info!(
        target: "local-books",
        "pdf_extract_succeeded book_id={} pages={} chars={} elapsed_ms={}",
        record.book_id,
        page_count,
        text.len(),
        started.elapsed().as_millis()
    );
    Ok(cache)
}

pub fn decode_txt_bytes(bytes: &[u8]) -> Result<(String, &'static str), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map(|text| (text, "UTF-8"))
            .map_err(|_| "TXT 的 UTF-8 BOM 后包含无效编码".to_string());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        if !(bytes.len() - 2).is_multiple_of(2) {
            return Err("TXT 的 UTF-16LE 字节数无效".to_string());
        }
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
        return String::from_utf16(&units.collect::<Vec<_>>())
            .map(|text| (text, "UTF-16LE"))
            .map_err(|_| "TXT 包含无效 UTF-16LE 编码".to_string());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        if !(bytes.len() - 2).is_multiple_of(2) {
            return Err("TXT 的 UTF-16BE 字节数无效".to_string());
        }
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]));
        return String::from_utf16(&units.collect::<Vec<_>>())
            .map(|text| (text, "UTF-16BE"))
            .map_err(|_| "TXT 包含无效 UTF-16BE 编码".to_string());
    }
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        if !text.contains('\0') {
            return Ok((text, "UTF-8"));
        }
    }
    if bytes.len() >= 4 && bytes.len().is_multiple_of(2) {
        let pairs = bytes.chunks_exact(2).collect::<Vec<_>>();
        let even_nuls = pairs.iter().filter(|pair| pair[0] == 0).count();
        let odd_nuls = pairs.iter().filter(|pair| pair[1] == 0).count();
        let threshold = pairs.len().max(1) / 3;
        if odd_nuls > threshold {
            let units = pairs
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            if let Ok(text) = String::from_utf16(&units) {
                return Ok((text, "UTF-16LE"));
            }
        }
        if even_nuls > threshold {
            let units = pairs
                .iter()
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            if let Ok(text) = String::from_utf16(&units) {
                return Ok((text, "UTF-16BE"));
            }
        }
        if let Some(decoded) = decode_utf16_without_bom(bytes) {
            return Ok(decoded);
        }
    }
    let (text, _, had_errors) = GB18030.decode(bytes);
    if had_errors {
        return Err("无法识别 TXT 编码（支持 UTF-8、UTF-16 和 GB18030）".to_string());
    }
    Ok((text.into_owned(), "GB18030"))
}

fn decode_utf16_without_bom(bytes: &[u8]) -> Option<(String, &'static str)> {
    let decode = |little_endian: bool| {
        let units = bytes
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16(&units).ok()
    };
    let mut candidates = [
        decode(true).map(|text| (text, "UTF-16LE")),
        decode(false).map(|text| (text, "UTF-16BE")),
    ]
    .into_iter()
    .flatten()
    .map(|candidate| {
        let score = utf16_text_score(&candidate.0);
        (candidate, score)
    })
    .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    let ((text, encoding), best_score) = candidates.first()?.clone();
    let character_count = text.chars().count() as i64;
    let runner_up = candidates
        .get(1)
        .map(|(_, score)| *score)
        .unwrap_or(i64::MIN);
    (character_count > 0
        && best_score >= character_count * 3
        && best_score.saturating_sub(runner_up) >= 2)
        .then_some((text, encoding))
}

fn utf16_text_score(text: &str) -> i64 {
    text.chars()
        .map(|character| match character {
            '\u{0009}' | '\u{000a}' | '\u{000d}' => 3,
            '\u{0020}'..='\u{007e}' => 3,
            '\u{3000}'..='\u{303f}' | '\u{ff01}'..='\u{ff65}' => 4,
            '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}' => 4,
            value if value.is_control() => -12,
            '\u{e000}'..='\u{f8ff}' | '\u{fffe}' | '\u{ffff}' => -8,
            value if value.is_alphanumeric() => 1,
            _ => 0,
        })
        .sum()
}

fn ensure_txt_size(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.len() > MAX_TXT_FILE_SIZE {
        return Err(format!(
            "TXT 文件过大（最大支持 {} MB）",
            MAX_TXT_FILE_SIZE / 1024 / 1024
        ));
    }
    Ok(())
}

fn ensure_mobi_size(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.len() > MAX_MOBI_FILE_SIZE {
        return Err(format!(
            "MOBI 文件过大（最大支持 {} MB）",
            MAX_MOBI_FILE_SIZE / 1024 / 1024
        ));
    }
    Ok(())
}

fn ensure_pdf_size(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.len() > MAX_PDF_FILE_SIZE {
        return Err(format!(
            "PDF 文件过大（最大支持 {} MB）",
            MAX_PDF_FILE_SIZE / 1024 / 1024
        ));
    }
    Ok(())
}

/// PDF 只读文件头魔数做轻校验；文本提取（可能秒级）延迟到打开流程，
/// 结果落缓存后经 /text 端点完全复用 TXT 阅读管线。
fn pdf_magic_valid(path: &Path) -> Result<(), String> {
    let mut magic = [0u8; 5];
    let mut file = File::open(path).map_err(|error| format!("无法打开 PDF：{error}"))?;
    file.read_exact(&mut magic)
        .map_err(|error| format!("PDF 文件损坏：{error}"))?;
    if &magic != b"%PDF-" {
        return Err("不是有效的 PDF 文件".to_string());
    }
    Ok(())
}

fn inspect_path(path: &Path) -> Result<LocalBookRecord, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法读取所选文件：{error}"))?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件".to_string());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("只支持 TXT、EPUB、MOBI/AZW3、PDF 文件")?;
    log::info!(
        target: "local-books",
        "inspect_start format={} size={}",
        extension,
        metadata.len()
    );
    log::info!(
        target: "frontend",
        "[LocalBooks] inspect_start format={} size={}",
        extension,
        metadata.len()
    );
    let fallback_title = canonical
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名图书")
        .trim()
        .to_string();
    let (format, parsed_title, fixed_layout) = match extension.as_str() {
        "txt" => {
            ensure_txt_size(&metadata)?;
            let bytes = fs::read(&canonical).map_err(|error| format!("无法读取 TXT：{error}"))?;
            let _ = decode_txt_bytes(&bytes)?;
            (LocalBookFormat::Txt, fallback_title.clone(), false)
        }
        "epub" => {
            let (title, fixed_layout) = parse_epub(&canonical)?;
            (
                LocalBookFormat::Epub,
                if title.is_empty() {
                    fallback_title.clone()
                } else {
                    title
                },
                fixed_layout,
            )
        }
        "mobi" | "azw3" => {
            ensure_mobi_size(&metadata)?;
            let title = parse_mobi(&canonical)?;
            (
                LocalBookFormat::Mobi,
                if title.is_empty() {
                    fallback_title.clone()
                } else {
                    title
                },
                false,
            )
        }
        // PDF 导入只做轻校验；秒级文本提取延迟到打开流程（extract_pdf_text）
        "pdf" => {
            ensure_pdf_size(&metadata)?;
            pdf_magic_valid(&canonical)?;
            (LocalBookFormat::Pdf, fallback_title.clone(), false)
        }
        _ => return Err("只支持 TXT、EPUB、MOBI/AZW3、PDF 文件".to_string()),
    };
    let path_key = canonical.to_string_lossy();
    let digest = Sha256::digest(path_key.as_bytes());
    let book_id = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let record = LocalBookRecord {
        book_id,
        path: canonical,
        format,
        title: parsed_title,
        file_size: metadata.len(),
        modified_at: modified_millis(&metadata),
        last_opened_at: now_millis(),
        fixed_layout,
    };
    log::info!(
        target: "local-books",
        "inspect_succeeded book_id={} format={} fixed_layout={}",
        record.book_id,
        extension,
        record.fixed_layout
    );
    log::info!(
        target: "frontend",
        "[LocalBooks] inspect_succeeded book_id={} format={} fixed_layout={}",
        record.book_id,
        extension,
        record.fixed_layout
    );
    Ok(record)
}

fn upsert_record<R: Runtime>(app: &AppHandle<R>, record: LocalBookRecord) -> Result<(), String> {
    with_document(app, |document| {
        document.books.retain(|book| book.book_id != record.book_id);
        document.books.push(record);
        Ok(((), true))
    })
}

#[cfg(target_os = "windows")]
pub fn local_reader_url(book_id: &str) -> tauri::Url {
    format!("http://atreader.localhost/local-reader?book={book_id}")
        .parse()
        .expect("valid local reader URL")
}

#[cfg(not(target_os = "windows"))]
pub fn local_reader_url(book_id: &str) -> tauri::Url {
    format!("atreader://localhost/local-reader?book={book_id}")
        .parse()
        .expect("valid local reader URL")
}

pub fn is_local_reader_url(url: &tauri::Url) -> bool {
    #[cfg(target_os = "windows")]
    let origin_matches = url.scheme() == "http"
        && url.host_str() == Some("atreader.localhost")
        && url.port().is_none();
    #[cfg(not(target_os = "windows"))]
    let origin_matches =
        url.scheme() == "atreader" && url.host_str() == Some("localhost") && url.port().is_none();
    origin_matches
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/local-reader"
}

pub fn book_id_from_url(url: &tauri::Url) -> Option<String> {
    if !is_local_reader_url(url) {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "book")
        .map(|(_, value)| value.into_owned())
        .filter(|book_id| validate_book_id(book_id).is_ok())
}

pub fn current_book_id<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.get_webview_window("main")
        .and_then(|window| window.url().ok())
        .and_then(|url| book_id_from_url(&url))
}

pub fn resolve_saved_local_url<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Value,
) -> Option<tauri::Url> {
    let remember_page = settings
        .get("global")
        .and_then(|global| global.get("lastPage"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !remember_page {
        return None;
    }
    let url = settings
        .get("sites")
        .and_then(|sites| sites.get("local"))
        .and_then(|site| site.get("lastReaderUrl"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<tauri::Url>().ok())?;
    let book_id = book_id_from_url(&url)?;
    match find_record(app, &book_id) {
        Ok(_) => Some(local_reader_url(&book_id)),
        Err(error) => {
            if let Some(message) = missing_notice(&error) {
                if let Ok(mut notice) = STARTUP_NOTICE.lock() {
                    *notice = Some(message);
                }
            }
            None
        }
    }
}

fn missing_notice(error: &str) -> Option<String> {
    error
        .strip_prefix("MISSING:")
        .map(|title| format!("找不到《{title}》，已删除阅读记录"))
}

pub fn take_startup_notice() -> Option<String> {
    STARTUP_NOTICE.lock().ok()?.take()
}

fn notify_missing<R: Runtime>(app: &AppHandle<R>, error: &str) {
    let Some(message) = missing_notice(error) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("show-toast", message);
    }
    let menu_app = app.clone();
    let _ = app.run_on_main_thread(move || crate::commands::refresh_app_menu(&menu_app));
}

fn ensure_default_settings<R: Runtime>(app: &AppHandle<R>) {
    let settings =
        crate::settings::read_settings(app).unwrap_or_else(|_| crate::settings::default_settings());
    let site = settings.get("sites").and_then(|sites| sites.get("local"));
    if site.is_none() {
        let _ = crate::settings::update_setting(app, "sites.local.zoom", json!(1.0));
        let _ = crate::settings::update_setting(app, "sites.local.readerWide", json!(false));
        let _ = crate::settings::update_setting(app, "sites.local.hideToolbar", json!(false));
        let _ = crate::settings::update_setting(app, "sites.local.hideNavbar", json!(false));
    }
    let config = settings
        .get("pluginConfigs")
        .and_then(|configs| configs.get("local"));
    if config.is_none() {
        let defaults = [
            ("columnMode", json!("double")),
            ("theme", json!("light")),
            (
                "fontFamily",
                json!("system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif"),
            ),
            ("fontSize", json!(28)),
            ("lineHeight", json!(1.8)),
            ("paragraphSpacing", json!(1)),
            ("pagePaddingX", json!(20)),
        ];
        for (key, value) in defaults {
            let _ =
                crate::settings::update_setting(app, &format!("pluginConfigs.local.{key}"), value);
        }
    }
}

fn navigate_record<R: Runtime>(app: &AppHandle<R>, record: &LocalBookRecord) -> Result<(), String> {
    log::info!(
        target: "frontend",
        "[LocalBooks] navigation_start book_id={} format={}",
        record.book_id,
        record.format.as_str()
    );
    ensure_default_settings(app);
    let url = local_reader_url(&record.book_id);
    crate::settings::update_setting(app, "global.lastSiteId", json!("local"))?;
    crate::settings::update_setting(app, "sites.local.lastReaderUrl", json!(url.as_str()))?;
    let window = app.get_webview_window("main").ok_or("主阅读窗口不存在")?;
    window
        .navigate(url)
        .map_err(|error| format!("无法打开本地图书：{error}"))?;
    let _ = window.set_zoom(1.0);
    Ok(())
}

pub fn open_book_by_id<R: Runtime>(app: &AppHandle<R>, book_id: &str) -> Result<(), String> {
    log::info!(target: "frontend", "[LocalBooks] recent_open_start book_id={book_id}");
    match find_record(app, book_id) {
        Ok(mut record) => {
            log::info!(
                target: "frontend",
                "[LocalBooks] recent_open_found book_id={} format={}",
                record.book_id,
                record.format.as_str()
            );
            record.last_opened_at = now_millis();
            upsert_record(app, record.clone())?;
            navigate_record(app, &record)?;
            crate::commands::refresh_app_menu(app);
            Ok(())
        }
        Err(error) if error.starts_with("MISSING:") => {
            log::warn!(target: "frontend", "[LocalBooks] recent_open_missing book_id={book_id}");
            notify_missing(app, &error);
            Ok(())
        }
        Err(error) => {
            log::warn!(
                target: "frontend",
                "[LocalBooks] recent_open_failed book_id={} error={}",
                book_id,
                error
            );
            Err(error)
        }
    }
}

/// 校验并导入一本书，随后把主窗口导航到本地阅读页。
/// 文件选择框、窗口拖拽、系统文件关联等入口共用。
pub fn open_book_from_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    let record = inspect_path(path)?;
    // PDF 的文本提取（秒级）在打开流程执行并落缓存；失败即打开失败
    if record.format == LocalBookFormat::Pdf {
        extract_pdf_text(app, &record)?;
    }
    log::info!(target: "local-books", "history_upsert_start");
    log::info!(target: "frontend", "[LocalBooks] history_upsert_start");
    upsert_record(app, record.clone())?;
    log::info!(
        target: "local-books",
        "history_upsert_succeeded book_id={}",
        record.book_id
    );
    log::info!(
        target: "frontend",
        "[LocalBooks] history_upsert_succeeded book_id={}",
        record.book_id
    );
    navigate_record(app, &record)?;
    log::info!(
        target: "local-books",
        "navigation_succeeded book_id={}",
        record.book_id
    );
    log::info!(
        target: "frontend",
        "[LocalBooks] navigation_succeeded book_id={}",
        record.book_id
    );
    crate::commands::refresh_app_menu(app);
    Ok(())
}

/// 打开失败时在主窗口弹出 toast 提示。
pub fn notify_open_failure<R: Runtime>(app: &AppHandle<R>, error: &str) {
    log::warn!(target: "local-books", "open_book_failed error={error}");
    log::warn!(target: "frontend", "[LocalBooks] open_book_failed error={error}");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("show-toast", local_error_toast(error));
    }
}

pub fn open_dialog<R: Runtime>(app: &AppHandle<R>) {
    log::info!(target: "frontend", "[LocalBooks] open_dialog_start");
    let app = app.clone();
    app.dialog()
        .file()
        .add_filter("本地图书", &["txt", "epub", "mobi", "azw3", "pdf"])
        .set_title("打开本地图书")
        .pick_file(move |selected| {
            let Some(selected) = selected else {
                log::info!(target: "local-books", "open_dialog_cancelled");
                log::info!(target: "frontend", "[LocalBooks] open_dialog_cancelled");
                return;
            };
            let Ok(path) = selected.into_path() else {
                log::warn!(target: "local-books", "open_dialog_path_conversion_failed");
                log::warn!(target: "frontend", "[LocalBooks] open_dialog_path_conversion_failed");
                return;
            };
            if let Err(error) = open_book_from_path(&app, &path) {
                log::warn!(target: "local-books", "open_dialog_failed error={error}");
                log::warn!(target: "frontend", "[LocalBooks] open_dialog_failed error={error}");
                notify_open_failure(&app, &error);
            }
        });
}

/// 路径扩展名是否为支持的本地图书格式（TXT / EPUB / MOBI/AZW3 / PDF，大小写不敏感）。
pub fn is_book_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("txt")
                || extension.eq_ignore_ascii_case("epub")
                || extension.eq_ignore_ascii_case("mobi")
                || extension.eq_ignore_ascii_case("azw3")
                || extension.eq_ignore_ascii_case("pdf")
        })
}

/// 与 plugin_installer::path_from_argument 同构：从命令行参数解析本地图书路径。
fn book_path_from_argument(argument: &str, cwd: &Path) -> Option<PathBuf> {
    let value = argument.trim();
    let raw = if value.starts_with("file://") {
        tauri::Url::parse(value).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(value)
    };
    let path = if raw.is_absolute() {
        raw
    } else {
        cwd.join(raw)
    };
    is_book_path(&path).then_some(path)
}

/// macOS RunEvent::Opened 入口：双击关联的 EPUB 或拖到 Dock 图标时接收文件 URL。
#[cfg(target_os = "macos")]
pub fn handle_opened_urls<R: Runtime>(app: &AppHandle<R>, urls: &[tauri::Url]) {
    let Some(path) = urls.iter().find_map(|url| {
        (url.scheme() == "file")
            .then(|| url.to_file_path().ok())
            .flatten()
            .filter(|path| is_book_path(path))
    }) else {
        return;
    };
    open_book_when_main_ready(app, path);
}

/// Windows/Linux 单实例回调与冷启动参数入口。
pub fn handle_external_arguments<R: Runtime>(app: &AppHandle<R>, arguments: &[String], cwd: &Path) {
    let Some(path) = arguments
        .iter()
        .find_map(|argument| book_path_from_argument(argument, cwd))
    else {
        return;
    };
    open_book_when_main_ready(app, path);
}

fn open_book_when_main_ready<R: Runtime>(app: &AppHandle<R>, path: PathBuf) {
    if app.get_webview_window("main").is_none() {
        if let Ok(mut pending) = PENDING_OPEN_BOOK.lock() {
            *pending = Some(path);
        }
        return;
    }
    if let Err(error) = open_book_from_path(app, &path) {
        notify_open_failure(app, &error);
    }
}

/// 主窗口创建后调用：补开先于 setup 到达的关联文件。
pub fn drain_pending_open_book<R: Runtime>(app: &AppHandle<R>) {
    let Ok(mut pending) = PENDING_OPEN_BOOK.lock() else {
        return;
    };
    let Some(path) = pending.take() else {
        return;
    };
    drop(pending);
    log::info!(
        target: "local-books",
        "pending_open_book_drained path={}",
        path.display()
    );
    if let Err(error) = open_book_from_path(app, &path) {
        notify_open_failure(app, &error);
    }
}

fn local_error_toast(error: &str) -> String {
    if error.starts_with("MISSING:") {
        return "图书文件已不存在".to_string();
    }
    if error.starts_with("暂不支持受 DRM") {
        return error.to_string();
    }
    if error.starts_with("EPUB 文件损坏") || error.contains("End of central directory") {
        return "EPUB 文件损坏或不是有效的 EPUB 文件".to_string();
    }
    if error.starts_with("EPUB") || error.contains("EPUB") {
        return "EPUB 结构无效，无法打开".to_string();
    }
    if error.starts_with("无法打开 EPUB") || error.starts_with("无法读取 EPUB") {
        return "无法读取 EPUB 文件".to_string();
    }
    error.to_string()
}

fn validate_local_runtime<R: Runtime>(
    window: &WebviewWindow<R>,
    expected_book_id: Option<&str>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("本地图书命令仅允许主阅读窗口调用".to_string());
    }
    let url = window
        .url()
        .map_err(|error| format!("无法读取窗口地址：{error}"))?;
    if !is_local_reader_url(&url) {
        return Err("当前页面不是本地阅读页".to_string());
    }
    if expected_book_id.is_some_and(|expected| book_id_from_url(&url).as_deref() != Some(expected))
    {
        return Err("当前页面无权访问这本本地图书".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_local_book<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    book_id: String,
) -> Result<LocalBookPublic, String> {
    log::info!(target: "frontend", "[LocalBooks] metadata_request book_id={book_id}");
    validate_local_runtime(&window, Some(&book_id))?;
    match find_record(&app, &book_id) {
        Ok(record) => {
            log::info!(target: "frontend", "[LocalBooks] metadata_succeeded book_id={book_id}");
            Ok(LocalBookPublic::from(&record))
        }
        Err(error) => {
            log::warn!(target: "frontend", "[LocalBooks] metadata_failed book_id={} error={}", book_id, error);
            notify_missing(&app, &error);
            Err(missing_notice(&error).unwrap_or(error))
        }
    }
}

#[tauri::command]
pub fn get_local_reading_progress<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    book_id: String,
) -> Result<Option<Value>, String> {
    validate_local_runtime(&window, Some(&book_id))?;
    let result = (|| {
        let _guard = LOCAL_BOOKS_LOCK
            .lock()
            .map_err(|_| "本地图书仓储锁已损坏".to_string())?;
        find_record_locked(&app, &book_id)?;
        read_progress(&progress_dir(&app)?.join(format!("{book_id}.json")))
    })();
    if let Err(error) = &result {
        notify_missing(&app, error);
    }
    result
}

fn read_progress(path: &Path) -> Result<Option<Value>, String> {
    match File::open(path) {
        Ok(file) => serde_json::from_reader(BufReader::new(file))
            .map(Some)
            .map_err(|error| format!("本地阅读进度损坏：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取本地阅读进度：{error}")),
    }
}

fn progress_updated_at(progress: &Value) -> Result<u64, String> {
    progress
        .get("updatedAt")
        .and_then(Value::as_u64)
        .ok_or_else(|| "本地阅读进度缺少有效更新时间".to_string())
}

fn write_progress_if_newer(path: &Path, progress: &Value) -> Result<bool, String> {
    let incoming_updated_at = progress_updated_at(progress)?;
    if let Some(existing) = read_progress(path).ok().flatten() {
        if progress_updated_at(&existing).unwrap_or(0) > incoming_updated_at {
            return Ok(false);
        }
    }
    atomic_write_json(path, progress)?;
    Ok(true)
}

#[tauri::command]
pub fn save_local_reading_progress<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    book_id: String,
    progress: Value,
) -> Result<(), String> {
    validate_local_runtime(&window, Some(&book_id))?;
    validate_book_id(&book_id)?;
    let serialized = serde_json::to_vec(&progress)
        .map_err(|error| format!("无法序列化本地阅读进度：{error}"))?;
    if serialized.len() > 16 * 1024 || !progress.is_object() {
        return Err("本地阅读进度无效".to_string());
    }
    progress_updated_at(&progress)?;
    let result: Result<(), String> = (|| {
        let _guard = LOCAL_BOOKS_LOCK
            .lock()
            .map_err(|_| "本地图书仓储锁已损坏".to_string())?;
        find_record_locked(&app, &book_id)?;
        write_progress_if_newer(
            &progress_dir(&app)?.join(format!("{book_id}.json")),
            &progress,
        )?;
        Ok(())
    })();
    if let Err(error) = &result {
        notify_missing(&app, error);
    }
    result.map_err(|error| missing_notice(&error).unwrap_or(error))
}

#[tauri::command]
pub fn local_sha1<R: Runtime>(window: WebviewWindow<R>, value: String) -> Result<Vec<u8>, String> {
    validate_local_runtime(&window, None)?;
    if value.len() > 4096 {
        return Err("SHA-1 输入过长".to_string());
    }
    use sha1::Digest as _;
    Ok(sha1::Sha1::digest(value.as_bytes()).to_vec())
}

#[tauri::command]
pub fn clear_local_history(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("只有设置窗口可以清空本地阅读记录".to_string());
    }
    let _guard = LOCAL_BOOKS_LOCK
        .lock()
        .map_err(|_| "本地图书仓储锁已损坏".to_string())?;
    atomic_write_json(&history_path(&app)?, &LocalBooksDocument::default())?;
    let progress = progress_dir(&app)?;
    if progress.exists() {
        fs::remove_dir_all(progress).map_err(|error| format!("无法清除本地阅读进度：{error}"))?;
    }
    let cache = cache_dir(&app)?;
    if cache.exists() {
        fs::remove_dir_all(cache).map_err(|error| format!("无法清除本地图书缓存：{error}"))?;
    }
    drop(_guard);
    crate::settings::update_setting(&app, "sites.local.lastReaderUrl", Value::Null)?;
    crate::commands::refresh_app_menu(&app);
    crate::navigate_away_after_local_history_clear(&app);
    Ok(())
}

fn response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    local_reader: bool,
) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-store");
    if local_reader {
        builder = builder.header(
            "content-security-policy",
            // connect-src 需含 blob:：MOBI 章节消毒管线要在页面上下文 fetch
            // mobi.js 生成的章节 blob 再重消毒；blob 为同实例内存数据，无网络面。
            // 书籍内容 iframe 另有 STRICT_EPUB_CSP（connect-src 'none'），不受影响。
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self' blob:; frame-src blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
        );
    }
    builder.body(body).expect("valid local protocol response")
}

fn error_response(status: u16, message: impl Into<String>) -> tauri::http::Response<Vec<u8>> {
    response(
        status,
        "application/json; charset=utf-8",
        serde_json::to_vec(&json!({ "error": message.into() })).unwrap_or_default(),
        true,
    )
}

fn mime_for_entry(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "xhtml" | "html" | "htm" => "application/xhtml+xml",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "xml" | "opf" | "ncx" => "application/xml",
        _ => "application/octet-stream",
    }
}

fn validate_epub_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\0')
        || name.contains('\\')
        || name.starts_with('/')
        || name.split('/').any(|part| part == "..")
    {
        return Err("EPUB 包含无效条目路径".to_string());
    }
    Ok(())
}

fn validate_archive_bounds(archive: &mut zip::ZipArchive<File>) -> Result<(), String> {
    validate_epub_size_limits(archive.len(), std::iter::empty())?;
    let mut sizes = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 EPUB 目录：{error}"))?;
        validate_epub_entry_name(entry.name())?;
        sizes.push(entry.size());
    }
    validate_epub_size_limits(archive.len(), sizes)
}

fn validate_epub_size_limits(
    entry_count: usize,
    sizes: impl IntoIterator<Item = u64>,
) -> Result<(), String> {
    if entry_count > MAX_EPUB_ENTRIES {
        return Err("EPUB 条目数量过多".to_string());
    }
    let mut total = 0u64;
    for size in sizes {
        if size > MAX_PROTOCOL_ENTRY_SIZE {
            return Err("EPUB 单个资源过大".to_string());
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| "EPUB 解压后大小溢出".to_string())?;
        if total > MAX_EPUB_TOTAL_SIZE {
            return Err("EPUB 解压后内容过大".to_string());
        }
    }
    Ok(())
}

fn epub_entries(record: &LocalBookRecord) -> Result<Vec<EpubEntryInfo>, String> {
    let file = File::open(&record.path).map_err(|error| format!("无法打开 EPUB：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("EPUB 文件损坏：{error}"))?;
    validate_archive_bounds(&mut archive)?;
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 EPUB 目录：{error}"))?;
        if !entry.is_dir() {
            entries.push(EpubEntryInfo {
                name: entry.name().to_string(),
                size: entry.size(),
            });
        }
    }
    Ok(entries)
}

fn epub_entry(record: &LocalBookRecord, name: &str) -> Result<(Vec<u8>, &'static str), String> {
    validate_epub_entry_name(name)?;
    let file = File::open(&record.path).map_err(|error| format!("无法打开 EPUB：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("EPUB 文件损坏：{error}"))?;
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("EPUB 条目不存在：{name}"))?;
    if entry.size() > MAX_PROTOCOL_ENTRY_SIZE {
        return Err("EPUB 单个资源过大".to_string());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 EPUB 条目：{error}"))?;
    Ok((bytes, mime_for_entry(name)))
}

fn local_resource_url_is_authorized(url: &tauri::Url, requested_book_id: Option<&str>) -> bool {
    let Some(current_book_id) = book_id_from_url(url) else {
        return false;
    };
    requested_book_id.is_none_or(|requested| requested == current_book_id)
}

#[cfg(test)]
pub fn protocol_response<R: Runtime>(
    app: &AppHandle<R>,
    webview_label: &str,
    path: &str,
    query: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    protocol_response_with_referer(app, webview_label, path, query, None)
}

pub fn protocol_response_with_referer<R: Runtime>(
    app: &AppHandle<R>,
    webview_label: &str,
    path: &str,
    query: Option<&str>,
    referer: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    if path == "/local-reader"
        || path == "/local-reader.js"
        || path == "/local-reader-bootstrap.js"
        || path == "/local-reader.css"
        || path.starts_with("/local/books/")
        || path == "/local-reader-diagnostic"
    {
        log::info!(
            target: "frontend",
            "[LocalBooks] protocol_request label={} path={} referer={}",
            webview_label,
            path,
            safe_referer_label(referer)
        );
    }
    if webview_label != "main" {
        log::warn!(target: "local-books", "protocol_denied_non_main label={} path={}", webview_label, path);
        log::warn!(target: "frontend", "[LocalBooks] protocol_denied_non_main label={} path={}", webview_label, path);
        return error_response(403, "本地阅读资源仅允许主窗口访问");
    }
    if path == "/local-reader" {
        return response(
            200,
            "text/html; charset=utf-8",
            LOCAL_READER_HTML.to_vec(),
            true,
        );
    }
    let current_url = app
        .get_webview_window(webview_label)
        .and_then(|window| window.url().ok());
    if !local_resource_request_is_authorized(current_url.as_ref(), referer, None) {
        log::warn!(target: "local-books", "protocol_denied_wrong_page path={}", path);
        log::warn!(target: "frontend", "[LocalBooks] protocol_denied_wrong_page path={} referer={}", path, safe_referer_label(referer));
        return error_response(403, "当前页面无权访问本地阅读资源");
    }
    match path {
        "/local-reader.js" => {
            return response(
                200,
                "text/javascript; charset=utf-8",
                LOCAL_READER_JS.to_vec(),
                true,
            )
        }
        "/local-reader-bootstrap.js" => {
            return response(
                200,
                "text/javascript; charset=utf-8",
                LOCAL_READER_BOOTSTRAP_JS.to_vec(),
                true,
            )
        }
        "/local-reader.css" => {
            return response(
                200,
                "text/css; charset=utf-8",
                LOCAL_READER_CSS.to_vec(),
                true,
            )
        }
        "/licenses/foliate-js" => {
            return response(
                200,
                "text/plain; charset=utf-8",
                FOLIATE_LICENSE.to_vec(),
                true,
            )
        }
        "/licenses/third-party" => {
            return response(
                200,
                "text/markdown; charset=utf-8",
                THIRD_PARTY_NOTICES.to_vec(),
                true,
            )
        }
        "/local-reader-diagnostic" => {
            let stage = query
                .and_then(|value| {
                    value
                        .split('&')
                        .find_map(|part| part.strip_prefix("stage="))
                })
                .and_then(|value| percent_decode_str(value).decode_utf8().ok())
                .map(|value| value.into_owned())
                .unwrap_or_else(|| "unknown".to_string());
            let detail = query
                .and_then(|value| {
                    value
                        .split('&')
                        .find_map(|part| part.strip_prefix("detail="))
                })
                .and_then(|value| percent_decode_str(value).decode_utf8().ok())
                .map(|value| value.into_owned())
                .unwrap_or_default();
            log::info!(
                target: "frontend",
                "[LocalReaderBootstrap] stage={} detail={}",
                stage,
                detail
            );
            return response(204, "text/plain; charset=utf-8", Vec::new(), true);
        }
        _ => {}
    }
    let Some(rest) = path.strip_prefix("/local/books/") else {
        return error_response(404, "Not Found");
    };
    let Some((book_id, resource)) = rest.split_once('/') else {
        return error_response(404, "Not Found");
    };
    if !local_resource_request_is_authorized(current_url.as_ref(), referer, Some(book_id)) {
        log::warn!(target: "local-books", "protocol_denied_book book_id={} resource={}", book_id, resource);
        log::warn!(target: "frontend", "[LocalBooks] protocol_denied_book book_id={} resource={} referer={}", book_id, resource, safe_referer_label(referer));
        return error_response(403, "当前页面无权访问这本本地图书");
    }
    let record = match find_record(app, book_id) {
        Ok(record) => record,
        Err(error) => {
            log::warn!(target: "local-books", "protocol_book_lookup_failed book_id={} error={}", book_id, error);
            log::warn!(target: "frontend", "[LocalBooks] protocol_book_lookup_failed book_id={} error={}", book_id, error);
            notify_missing(app, &error);
            return error_response(
                if error.starts_with("MISSING:") {
                    410
                } else {
                    404
                },
                error,
            );
        }
    };
    match resource {
        "metadata" => response(
            200,
            "application/json; charset=utf-8",
            serde_json::to_vec(&LocalBookPublic::from(&record)).unwrap_or_default(),
            true,
        ),
        // PDF 文本缓存缺失时的兜底重建（extract_pdf_text 对新鲜缓存零开销）
        "text" if record.format == LocalBookFormat::Pdf => {
            match extract_pdf_text(app, &record).and_then(|cache| {
                fs::read(&cache).map_err(|error| format!("无法读取 PDF 文本缓存：{error}"))
            }) {
                Ok(bytes) => response(200, "text/plain; charset=utf-8", bytes, true),
                Err(error) => {
                    log::warn!(target: "local-books", "pdf_text_failed book_id={} error={}", book_id, error);
                    log::warn!(target: "frontend", "[LocalBooks] pdf_text_failed book_id={} error={}", book_id, error);
                    error_response(422, error)
                }
            }
        }
        "text" if record.format == LocalBookFormat::Txt => match fs::metadata(&record.path)
            .map_err(|error| format!("无法读取 TXT 文件信息：{error}"))
            .and_then(|metadata| ensure_txt_size(&metadata))
            .and_then(|()| fs::read(&record.path).map_err(|error| format!("无法读取 TXT：{error}")))
            .and_then(|bytes| decode_txt_bytes(&bytes).map(|value| value.0))
        {
            Ok(text) => response(200, "text/plain; charset=utf-8", text.into_bytes(), true),
            Err(error) => {
                log::warn!(target: "local-books", "txt_resource_failed book_id={} error={}", book_id, error);
                log::warn!(target: "frontend", "[LocalBooks] txt_resource_failed book_id={} error={}", book_id, error);
                error_response(422, error)
            }
        },
        "file" if record.format == LocalBookFormat::Mobi => match fs::metadata(&record.path)
            .map_err(|error| format!("无法读取 MOBI 文件信息：{error}"))
            .and_then(|metadata| ensure_mobi_size(&metadata))
            .and_then(|()| fs::read(&record.path).map_err(|error| format!("无法读取 MOBI：{error}")))
        {
            Ok(bytes) => response(200, "application/octet-stream", bytes, true),
            Err(error) => {
                log::warn!(target: "local-books", "mobi_resource_failed book_id={} error={}", book_id, error);
                log::warn!(target: "frontend", "[LocalBooks] mobi_resource_failed book_id={} error={}", book_id, error);
                error_response(422, error)
            }
        },
        "entries" if record.format == LocalBookFormat::Epub => match epub_entries(&record) {
            Ok(entries) => response(
                200,
                "application/json; charset=utf-8",
                serde_json::to_vec(&entries).unwrap_or_default(),
                true,
            ),
            Err(error) => {
                log::warn!(target: "local-books", "epub_entries_failed book_id={} error={}", book_id, error);
                log::warn!(target: "frontend", "[LocalBooks] epub_entries_failed book_id={} error={}", book_id, error);
                error_response(422, error)
            }
        },
        "entry" if record.format == LocalBookFormat::Epub => {
            let name = query
                .and_then(|value| value.strip_prefix("name="))
                .and_then(|value| percent_decode_str(value).decode_utf8().ok())
                .map(|value| value.into_owned())
                .unwrap_or_default();
            match epub_entry(&record, &name) {
                Ok((bytes, mime)) => response(200, mime, bytes, true),
                Err(error) => {
                    log::warn!(target: "local-books", "epub_entry_failed book_id={} name={} error={}", book_id, name, error);
                    log::warn!(target: "frontend", "[LocalBooks] epub_entry_failed book_id={} name={} error={}", book_id, name, error);
                    error_response(404, error)
                }
            }
        }
        _ => error_response(404, "Not Found"),
    }
}

fn local_resource_request_is_authorized(
    current_url: Option<&tauri::Url>,
    referer: Option<&str>,
    requested_book_id: Option<&str>,
) -> bool {
    if current_url.is_some_and(|url| local_resource_url_is_authorized(url, requested_book_id)) {
        return true;
    }
    referer
        .and_then(|value| value.parse::<tauri::Url>().ok())
        .is_some_and(|url| local_resource_url_is_authorized(&url, requested_book_id))
}

fn safe_referer_label(referer: Option<&str>) -> String {
    let Some(value) = referer else {
        return "<none>".to_string();
    };
    let Ok(url) = value.parse::<tauri::Url>() else {
        return "<invalid>".to_string();
    };
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.path()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn test_path(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "atreader-local-books-test-{}-{}-{suffix}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write_test_epub(opf: &str, spine: Option<&str>) -> PathBuf {
        let path = test_path("book.epub");
        let file = File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive
            .write_all(
                br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .unwrap();
        archive.start_file("OPS/package.opf", options).unwrap();
        archive.write_all(opf.as_bytes()).unwrap();
        if let Some(spine) = spine {
            archive.start_file("OPS/chapter.xhtml", options).unwrap();
            archive.write_all(spine.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
        path
    }

    #[test]
    fn decodes_supported_txt_encodings() {
        assert_eq!(decode_txt_bytes("第一章".as_bytes()).unwrap().1, "UTF-8");
        assert_eq!(decode_txt_bytes(&[0xFF, 0xFE, 0x2D, 0x4E]).unwrap().0, "中");
        assert_eq!(
            decode_txt_bytes(&[b'A', 0, b'B', 0, b'C', 0]).unwrap().0,
            "ABC"
        );
        assert_eq!(
            decode_txt_bytes(&[0x2d, 0x4e, 0x87, 0x65]).unwrap(),
            ("中文".to_string(), "UTF-16LE")
        );
        assert_eq!(
            decode_txt_bytes(&[0x4e, 0x2d, 0x65, 0x87]).unwrap(),
            ("中文".to_string(), "UTF-16BE")
        );
        let (gb, _, _) = GB18030.encode("中文");
        assert_eq!(
            decode_txt_bytes(&gb).unwrap(),
            ("中文".to_string(), "GB18030")
        );
    }

    #[test]
    fn rejects_invalid_book_ids() {
        assert!(validate_book_id("../book").is_err());
        assert!(validate_book_id(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn book_argument_accepts_supported_book_paths() {
        let cwd = Path::new("/tmp/local-books-tests");
        assert_eq!(
            book_path_from_argument("三体.epub", cwd),
            Some(cwd.join("三体.epub"))
        );
        assert_eq!(
            book_path_from_argument("NOTES.TXT", cwd),
            Some(cwd.join("NOTES.TXT"))
        );
        assert_eq!(
            book_path_from_argument("书.mobi", cwd),
            Some(cwd.join("书.mobi"))
        );
        assert_eq!(book_path_from_argument("书.AZW3", cwd),
            Some(cwd.join("书.AZW3"))
        );
        assert_eq!(
            book_path_from_argument("论文.pdf", cwd),
            Some(cwd.join("论文.pdf"))
        );
        assert_eq!(
            book_path_from_argument(
                if cfg!(windows) {
                    "file:///D:/tmp/%E4%B8%89%E4%BD%93.epub"
                } else {
                    "file:///tmp/%E4%B8%89%E4%BD%93.epub"
                },
                cwd
            ),
            Some(if cfg!(windows) {
                PathBuf::from(r"D:\tmp\三体.epub")
            } else {
                PathBuf::from("/tmp/三体.epub")
            })
        );
        assert_eq!(book_path_from_argument("plugin.atrd", cwd), None);
        // PRC 是未支持的旧格式，即使内容是 MOBI 也不经由扩展名放行
        assert_eq!(book_path_from_argument("/abs/path/novel.prc", cwd), None);
    }

    /// 构造最小 MOBI：PDB 头 78 字节 + 记录表 8 字节 + 记录 0（256 字节，
    /// MOBI 头长 232 + 内嵌标题区）。
    fn write_test_mobi(title: Option<&str>, pdb_name: &str, encryption: u16) -> PathBuf {
        let mut data = vec![0u8; 86 + 256];
        let name_bytes = pdb_name.as_bytes();
        let name_len = name_bytes.len().min(32);
        data[0..name_len].copy_from_slice(&name_bytes[..name_len]);
        data[60..68].copy_from_slice(b"BOOKMOBI");
        data[76..78].copy_from_slice(&1u16.to_be_bytes());
        data[78..82].copy_from_slice(&86u32.to_be_bytes());
        let record0 = &mut data[86..];
        record0[0..2].copy_from_slice(&2u16.to_be_bytes());
        record0[12..14].copy_from_slice(&encryption.to_be_bytes());
        record0[16..20].copy_from_slice(b"MOBI");
        record0[20..24].copy_from_slice(&232u32.to_be_bytes());
        record0[28..32].copy_from_slice(&65001u32.to_be_bytes());
        if let Some(title) = title {
            let bytes = title.as_bytes();
            let len = bytes.len().min(24);
            record0[84..88].copy_from_slice(&232u32.to_be_bytes());
            record0[88..92].copy_from_slice(&(len as u32).to_be_bytes());
            record0[232..232 + len].copy_from_slice(&bytes[..len]);
        }
        let path = test_path("book.mobi");
        fs::write(&path, &data).unwrap();
        path
    }

    #[test]
    fn parses_mobi_title_and_rejects_drm() {
        let path = write_test_mobi(Some("测试书名"), "PalmName", 0);
        assert_eq!(parse_mobi(&path).unwrap(), "测试书名");

        let path = write_test_mobi(None, "PalmName", 0);
        assert_eq!(parse_mobi(&path).unwrap(), "PalmName");

        let path = write_test_mobi(Some("测试书名"), "PalmName", 1);
        let error = parse_mobi(&path).unwrap_err();
        assert!(error.contains("DRM"), "unexpected error: {error}");

        let path = test_path("book.mobi");
        fs::write(&path, vec![0u8; 40]).unwrap();
        assert!(parse_mobi(&path).is_err());
    }

    /// 构造最小有效 PDF：单页 + Helvetica 文本对象，xref 偏移按实际字节
    /// 位置计算。content_stream 传非 BT/ET 操作符即模拟无文字层（扫描版）。
    fn write_test_pdf(content_stream: &str) -> PathBuf {
        let objects: [(&str, bool); 5] = [
            ("<</Type/Catalog/Pages 2 0 R>>", false),
            ("<</Type/Pages/Kids[3 0 R]/Count 1>>", false),
            (
                "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
                false,
            ),
            ("", true),
            ("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>", false),
        ];
        let mut buf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, (body, is_stream)) in objects.iter().enumerate() {
            offsets.push(buf.len() as u32);
            let entry = if *is_stream {
                format!("{0} 0 obj\n<</Length {1}>>\nstream\n{2}\nendstream\nendobj\n", index + 1, content_stream.len(), content_stream)
            } else {
                format!("{} 0 obj\n{}\nendobj\n", index + 1, body)
            };
            buf.extend_from_slice(entry.as_bytes());
        }
        let xref_pos = buf.len();
        buf.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for offset in &offsets {
            buf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        buf.extend_from_slice(
            format!("trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n{xref_pos}\n%%EOF").as_bytes(),
        );
        let path = test_path("book.pdf");
        fs::write(&path, &buf).unwrap();
        path
    }

    #[test]
    fn extracts_pdf_text_and_rejects_empty_or_invalid() {
        let path = write_test_pdf("BT /F1 24 Tf 72 720 Td (Hello atreader) Tj ET");
        let pages = pdf_extract::extract_text_by_pages(&path).unwrap();
        assert!(pages.iter().any(|page| page.contains("Hello atreader")));
        assert!(pdf_magic_valid(&path).is_ok());

        // 无文字操作符 = 扫描版/纯图片形态：提取结果为空白
        let empty = write_test_pdf("0 0 0 RG");
        let pages = pdf_extract::extract_text_by_pages(&empty).unwrap();
        assert!(pages.iter().all(|page| page.trim().is_empty()));

        let bad = test_path("bad.pdf");
        fs::write(&bad, b"not a pdf at all........").unwrap();
        assert!(pdf_magic_valid(&bad).is_err());

        let record = inspect_path(&path).unwrap();
        assert_eq!(record.format, LocalBookFormat::Pdf);
        assert_eq!(record.fixed_layout, false);
    }

    #[test]
    fn normalizes_kangxi_radicals_in_pdf_text() {
        // Chrome 打印的 PDF 把「一/用/文」等与部首同形的字落在康熙部首区，
        // 「长/门」等简化部首形落在补充区
        assert_eq!(
            normalize_pdf_text("第⼀章 ⽤⼆ 中⽂ ⾜够 ⻓度 ⼊⻔ ⻢".to_string()),
            "第一章 用二 中文 足够 长度 入门 马"
        );
        // 全角标点与其余字符必须原样保留（NFKC 全局应用会半角化标点）
        assert_eq!(
            normalize_pdf_text("「你好」，！？；：１２３".to_string()),
            "「你好」，！？；：１２３"
        );
    }

    #[test]
    fn keeps_recent_history_bounded() {
        let mut document = LocalBooksDocument::default();
        for index in 0..12 {
            document.books.push(LocalBookRecord {
                book_id: format!("{index:064x}"),
                path: PathBuf::from(format!("book-{index}.txt")),
                format: LocalBookFormat::Txt,
                title: format!("Book {index}"),
                file_size: 1,
                modified_at: 1,
                last_opened_at: index,
                fixed_layout: false,
            });
        }
        let evicted = sort_and_truncate(&mut document);
        assert_eq!(document.books.len(), 10);
        assert_eq!(document.books[0].title, "Book 11");
        assert_eq!(evicted.len(), 2);
        assert_eq!(evicted[0].title, "Book 1");
        assert_eq!(evicted[1].title, "Book 0");
    }

    #[test]
    fn rejects_unsafe_or_oversized_epub_entries() {
        assert!(validate_epub_entry_name("OPS/chapter.xhtml").is_ok());
        assert!(validate_epub_entry_name("../secret.txt").is_err());
        assert!(validate_epub_entry_name("OPS\\chapter.xhtml").is_err());
        assert!(validate_epub_size_limits(MAX_EPUB_ENTRIES + 1, []).is_err());
        assert!(validate_epub_size_limits(1, [MAX_PROTOCOL_ENTRY_SIZE + 1]).is_err());
        assert!(validate_epub_size_limits(17, [MAX_PROTOCOL_ENTRY_SIZE; 17]).is_err());
    }

    #[test]
    fn local_protocol_is_main_window_only_and_sets_strict_headers() {
        let app = tauri::test::mock_app();
        let denied = protocol_response(app.handle(), "settings", "/local-reader", None);
        assert_eq!(denied.status(), 403);

        let allowed = protocol_response(app.handle(), "main", "/local-reader", None);
        assert_eq!(allowed.status(), 200);
        assert_eq!(
            allowed.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        let csp = allowed
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("'unsafe-eval'"));

        let protected = protocol_response(app.handle(), "main", "/local-reader.js", None);
        assert_eq!(protected.status(), 403);
    }

    #[test]
    fn local_protocol_accepts_local_reader_referer_during_navigation_race() {
        let app = tauri::test::mock_app();
        let book_id = "a".repeat(64);
        let referer = local_reader_url(&book_id);
        let response = protocol_response_with_referer(
            app.handle(),
            "main",
            "/local-reader.js",
            None,
            Some(referer.as_str()),
        );
        assert_eq!(response.status(), 200);
        let bootstrap = protocol_response_with_referer(
            app.handle(),
            "main",
            "/local-reader-bootstrap.js",
            None,
            Some(referer.as_str()),
        );
        assert_eq!(bootstrap.status(), 200);
        let diagnostic = protocol_response_with_referer(
            app.handle(),
            "main",
            "/local-reader-diagnostic",
            Some("stage=bootstrap_started"),
            Some(referer.as_str()),
        );
        assert_eq!(diagnostic.status(), 204);
    }

    #[test]
    fn local_resource_authorization_requires_exact_origin_and_matching_book() {
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        let valid = local_reader_url(&first);
        assert!(is_local_reader_url(&valid));
        assert!(local_resource_url_is_authorized(&valid, None));
        assert!(local_resource_url_is_authorized(&valid, Some(&first)));
        assert!(!local_resource_url_is_authorized(&valid, Some(&second)));

        #[cfg(not(target_os = "windows"))]
        let wrong_origin: tauri::Url =
            format!("https://atreader.localhost/local-reader?book={first}")
                .parse()
                .unwrap();
        #[cfg(target_os = "windows")]
        let wrong_origin: tauri::Url = format!("atreader://localhost/local-reader?book={first}")
            .parse()
            .unwrap();
        assert!(!is_local_reader_url(&wrong_origin));
        assert!(!local_resource_url_is_authorized(&wrong_origin, None));
    }

    #[test]
    fn epub_preflight_requires_a_readable_existing_spine() {
        let opf = r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#;
        let valid = write_test_epub(
            opf,
            Some(r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>正文</body></html>"#),
        );
        assert_eq!(parse_epub(&valid).unwrap(), ("测试书".to_string(), false));
        fs::remove_file(&valid).unwrap();

        let with_doctype = write_test_epub(
            opf,
            Some(
                r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body>正文</body></html>"#,
            ),
        );
        assert_eq!(
            parse_epub(&with_doctype).unwrap(),
            ("测试书".to_string(), false)
        );
        fs::remove_file(&with_doctype).unwrap();

        let missing = write_test_epub(opf, None);
        let error = parse_epub(&missing).unwrap_err();
        assert!(error.contains("spine 资源不存在"), "{error}");
        fs::remove_file(&missing).unwrap();

        let broken = write_test_epub(opf, Some("<html><body>"));
        let error = parse_epub(&broken).unwrap_err();
        assert!(error.contains("spine XML 无效"), "{error}");
        fs::remove_file(&broken).unwrap();
    }

    #[test]
    fn stale_progress_cannot_overwrite_a_newer_position() {
        let directory = test_path("progress");
        let path = directory.join("book.json");
        let newer = json!({ "updatedAt": 20, "sectionIndex": 2 });
        let stale = json!({ "updatedAt": 10, "sectionIndex": 1 });
        assert!(write_progress_if_newer(&path, &newer).unwrap());
        assert!(!write_progress_if_newer(&path, &stale).unwrap());
        assert_eq!(read_progress(&path).unwrap(), Some(newer));
        assert!(write_progress_if_newer(&path, &json!({ "sectionIndex": 3 })).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_txt_files_above_the_memory_safety_limit() {
        let path = test_path("oversized.txt");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_TXT_FILE_SIZE + 1).unwrap();
        assert!(ensure_txt_size(&file.metadata().unwrap()).is_err());
        fs::remove_file(path).unwrap();
    }
}
