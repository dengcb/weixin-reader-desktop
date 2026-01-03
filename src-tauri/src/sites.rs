/// 站点配置结构体
/// 用于管理多个阅读网站的配置信息
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SiteConfig {
  /// 站点 ID (用于内部识别)
  pub id: &'static str,
  /// 站点名称 (显示用)
  pub name: &'static str,
  /// 站点域名 (用于网络检测)
  pub domain: &'static str,
  /// 站点首页 URL
  pub home_url: &'static str,
}

impl SiteConfig {
  /// 获取网络检测地址 (domain:443)
  pub fn network_check_addr(&self) -> String {
    format!("{}:443", self.domain)
  }
}

/// 微信读书配置
pub const WEREAD: SiteConfig = SiteConfig {
  id: "weread",
  name: "微信读书",
  domain: "weread.qq.com",
  home_url: "https://weread.qq.com/",
};

/// 当前默认站点配置
/// 未来支持多站点时可以改为动态选择
pub const DEFAULT_SITE: &SiteConfig = &WEREAD;
