const fs = require("node:fs");
const path = require("node:path");

const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

// Trusts the self-hosted T3 server's self-signed certificate (certs/t3-server.pem)
// alongside the system CAs, and keeps cleartext HTTP allowed for tailnet/LAN pairing.
// Once android:networkSecurityConfig is set, the usesCleartextTraffic manifest
// attribute is ignored on API 24+, so cleartext must be re-permitted here.

const CERT_SOURCE = path.join(__dirname, "..", "certs", "t3-server.crt");

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
      <certificates src="@raw/t3_server_cert" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

module.exports = function withAndroidSelfSignedServerTrust(config) {
  config = withDangerousMod(config, [
    "android",
    (nextConfig) => {
      const resDir = path.join(
        nextConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
      );

      const rawDir = path.join(resDir, "raw");
      fs.mkdirSync(rawDir, { recursive: true });
      fs.copyFileSync(CERT_SOURCE, path.join(rawDir, "t3_server_cert.pem"));

      const xmlDir = path.join(resDir, "xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "network_security_config.xml"), NETWORK_SECURITY_CONFIG);

      return nextConfig;
    },
  ]);

  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];

    if (application == null) {
      throw new Error(
        "AndroidManifest.xml is missing the application element required for network security configuration.",
      );
    }

    application.$ ??= {};
    application.$["android:networkSecurityConfig"] = "@xml/network_security_config";

    return nextConfig;
  });
};
