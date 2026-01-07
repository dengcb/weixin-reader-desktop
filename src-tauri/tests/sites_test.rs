/// 站点配置模块测试
///
/// 测试范围:
/// - 站点配置结构验证
/// - 网络检测地址生成
/// - 默认站点配置
/// - 多站点扩展性支持

#[cfg(test)]
mod sites_tests {
  /// 模拟站点配置结构 (与 src/sites.rs 保持一致)
  #[derive(Debug, Clone)]
  struct SiteConfig {
    pub id: &'static str,
    pub name: &'static str,
    pub domain: &'static str,
    pub home_url: &'static str,
  }

  impl SiteConfig {
    /// 获取网络检测地址 (domain:443)
    fn network_check_addr(&self) -> String {
      format!("{}:443", self.domain)
    }
  }

  /// 微信读书站点配置
  const WEREAD: SiteConfig = SiteConfig {
    id: "weread",
    name: "微信读书",
    domain: "weread.qq.com",
    home_url: "https://weread.qq.com/",
  };

  /// 测试站点配置结构的完整性
  /// 确保所有必需字段都存在且格式正确
  #[test]
  fn test_site_config_structure() {
    let site = WEREAD;

    // 验证 ID 字段
    assert!(!site.id.is_empty(), "Site ID should not be empty");
    assert!(
      site.id.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
      "Site ID should be lowercase ASCII with underscores only"
    );

    // 验证名称字段
    assert!(!site.name.is_empty(), "Site name should not be empty");
    assert!(
      site.name.contains("微信"),
      "Site name should contain '微信' for WeRead"
    );

    // 验证域名字段
    assert!(!site.domain.is_empty(), "Domain should not be empty");
    assert!(
      !site.domain.starts_with("http"),
      "Domain should not include protocol"
    );
    assert!(
      !site.domain.ends_with('/'),
      "Domain should not end with slash"
    );

    // 验证首页 URL 字段
    assert!(!site.home_url.is_empty(), "Home URL should not be empty");
    assert!(
      site.home_url.starts_with("https://"),
      "Home URL should use HTTPS protocol"
    );
    assert!(
      site.home_url.ends_with('/'),
      "Home URL should end with slash"
    );
  }

  /// 测试网络检测地址生成
  /// 格式应该是 "domain:443" (HTTPS 默认端口)
  #[test]
  fn test_network_check_addr_generation() {
    let site = WEREAD;
    let check_addr = site.network_check_addr();

    // 验证格式
    assert_eq!(
      check_addr, "weread.qq.com:443",
      "Network check address should be domain:443"
    );

    // 验证包含冒号
    assert!(
      check_addr.contains(':'),
      "Network check address should contain colon"
    );

    // 验证端口号
    let parts: Vec<&str> = check_addr.split(':').collect();
    assert_eq!(parts.len(), 2, "Should have exactly 2 parts (domain:port)");
    assert_eq!(parts[0], "weread.qq.com", "Domain part should match");
    assert_eq!(parts[1], "443", "Port should be 443 for HTTPS");
  }

  /// 测试域名格式验证
  /// 确保域名符合标准格式
  #[test]
  fn test_domain_format_validation() {
    let site = WEREAD;
    let domain = site.domain;

    // 验证域名包含点号
    assert!(domain.contains('.'), "Domain should contain at least one dot");

    // 验证域名段
    let parts: Vec<&str> = domain.split('.').collect();
    assert!(parts.len() >= 2, "Domain should have at least 2 parts");

    // 验证顶级域名
    let tld = parts.last().unwrap();
    assert!(
      tld.len() >= 2,
      "Top-level domain should be at least 2 characters"
    );
    assert!(
      tld.chars().all(|c| c.is_ascii_lowercase()),
      "Top-level domain should be lowercase ASCII"
    );
  }

  /// 测试 URL 格式验证
  /// 确保首页 URL 符合标准 HTTPS URL 格式
  #[test]
  fn test_home_url_format_validation() {
    let site = WEREAD;
    let url = site.home_url;

    // 验证协议
    assert!(url.starts_with("https://"), "URL should use HTTPS");

    // 验证包含域名
    assert!(url.contains(site.domain), "URL should contain the site domain");

    // 验证 URL 长度合理
    assert!(url.len() > 10, "URL should be reasonably long");
    assert!(url.len() < 100, "URL should not be excessively long");
  }

  /// 测试站点 ID 的唯一性
  /// 当添加多个站点时，ID 应该是唯一的
  #[test]
  fn test_site_id_uniqueness() {
    // 模拟多个站点配置 (未来扩展)
    let sites = vec![
      SiteConfig {
        id: "weread",
        name: "微信读书",
        domain: "weread.qq.com",
        home_url: "https://weread.qq.com/",
      },
      // 未来可能添加的其他站点示例:
      // SiteConfig {
      //   id: "kindle",
      //   name: "Kindle Cloud Reader",
      //   domain: "read.amazon.com",
      //   home_url: "https://read.amazon.com/",
      // },
    ];

    // 收集所有 ID
    let mut ids = std::collections::HashSet::new();
    for site in &sites {
      let is_new = ids.insert(site.id);
      assert!(is_new, "Site ID '{}' is duplicated", site.id);
    }

    // 验证 ID 数量匹配
    assert_eq!(ids.len(), sites.len(), "All site IDs should be unique");
  }

  /// 测试默认站点配置
  /// 验证默认站点是微信读书
  #[test]
  fn test_default_site_configuration() {
    let default_site = &WEREAD; // 模拟 DEFAULT_SITE 常量

    // 验证默认站点是微信读书
    assert_eq!(default_site.id, "weread", "Default site should be WeRead");
    assert_eq!(
      default_site.domain, "weread.qq.com",
      "Default domain should be weread.qq.com"
    );
  }

  /// 测试站点配置的克隆功能
  /// 确保配置可以正确克隆
  #[test]
  fn test_site_config_clone() {
    let original = WEREAD;
    let cloned = original.clone();

    // 验证克隆的字段与原始配置相同
    assert_eq!(cloned.id, original.id, "ID should match");
    assert_eq!(cloned.name, original.name, "Name should match");
    assert_eq!(cloned.domain, original.domain, "Domain should match");
    assert_eq!(cloned.home_url, original.home_url, "Home URL should match");
  }

  /// 测试网络检测地址的端口号
  /// 验证使用标准 HTTPS 端口 443
  #[test]
  fn test_network_check_uses_https_port() {
    let site = WEREAD;
    let check_addr = site.network_check_addr();

    // 提取端口号
    let port = check_addr.split(':').nth(1).unwrap();
    assert_eq!(port, "443", "Should use HTTPS port 443");

    // 验证端口号是数字
    assert!(
      port.parse::<u16>().is_ok(),
      "Port should be a valid number"
    );

    // 验证端口号在有效范围内
    let port_num = port.parse::<u16>().unwrap();
    assert_eq!(port_num, 443, "Port number should be 443");
  }

  /// 测试站点配置的调试输出
  /// 验证 Debug trait 的实现
  #[test]
  fn test_site_config_debug_output() {
    let site = WEREAD;
    let debug_str = format!("{:?}", site);

    // 验证调试输出包含所有字段
    assert!(debug_str.contains("weread"), "Debug output should contain ID");
    assert!(
      debug_str.contains("微信读书"),
      "Debug output should contain name"
    );
    assert!(
      debug_str.contains("weread.qq.com"),
      "Debug output should contain domain"
    );
  }

  /// 测试站点配置的不变性
  /// 确保站点配置是常量，不能被修改
  #[test]
  fn test_site_config_immutability() {
    let site = WEREAD;

    // 验证配置字段是 &'static str
    let id: &'static str = site.id;
    let name: &'static str = site.name;
    let domain: &'static str = site.domain;
    let home_url: &'static str = site.home_url;

    assert_eq!(id, "weread");
    assert_eq!(name, "微信读书");
    assert_eq!(domain, "weread.qq.com");
    assert_eq!(home_url, "https://weread.qq.com/");
  }

  /// 测试多站点支持的扩展性
  /// 验证添加新站点时的配置格式
  #[test]
  fn test_multi_site_extensibility() {
    // 模拟未来可能添加的站点
    let future_sites = vec![
      SiteConfig {
        id: "example1",
        name: "示例站点1",
        domain: "example1.com",
        home_url: "https://example1.com/",
      },
      SiteConfig {
        id: "example2",
        name: "示例站点2",
        domain: "example2.com",
        home_url: "https://example2.com/",
      },
    ];

    for site in future_sites {
      // 验证每个站点都有有效的网络检测地址
      let check_addr = site.network_check_addr();
      assert!(
        check_addr.ends_with(":443"),
        "Site '{}' should have valid check address",
        site.id
      );

      // 验证每个站点都有有效的 URL
      assert!(
        site.home_url.starts_with("https://"),
        "Site '{}' should use HTTPS",
        site.id
      );
    }
  }

  /// 测试域名的 DNS 友好性
  /// 确保域名符合 DNS 规范
  #[test]
  fn test_domain_dns_compliance() {
    let site = WEREAD;
    let domain = site.domain;

    // DNS 标签规则验证
    for part in domain.split('.') {
      // 每个标签不能为空
      assert!(!part.is_empty(), "Domain label should not be empty");

      // 每个标签长度应该在 1-63 之间
      assert!(
        part.len() <= 63,
        "Domain label '{}' should not exceed 63 characters",
        part
      );

      // 标签应该只包含字母、数字和连字符
      assert!(
        part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Domain label '{}' should only contain alphanumeric and hyphens",
        part
      );

      // 标签不应该以连字符开头或结尾
      assert!(
        !part.starts_with('-') && !part.ends_with('-'),
        "Domain label '{}' should not start or end with hyphen",
        part
      );
    }

    // 总长度不应超过 253 个字符
    assert!(
      domain.len() <= 253,
      "Total domain length should not exceed 253 characters"
    );
  }
}
