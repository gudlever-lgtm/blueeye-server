'use strict';

// Well-known service names for ports — turns a bare port number into the kind
// of traffic it usually carries ("443/tcp" -> "HTTPS", "53" -> "DNS"). Used by
// the flow explorer's "Top ports" table so operators read *what* is talking,
// not just a number.
//
// Metadata only (no payload / DPI): this is a static lookup of the public,
// well-known (IANA) port assignments — the same privacy stance as the traffic
// categories. A match is a hint, not proof: anything can bind any port, so the
// name is the conventional service for that port, not a guarantee.
//
// Kept intentionally small and explainable. It overlaps with (but is finer than)
// the traffic *categories* in categories.js: categories bucket many ports into a
// group ("Web"), this names the individual service ("HTTPS", "HTTP-alt").
const WELL_KNOWN = new Map([
  [20, 'FTP-data'], [21, 'FTP'], [22, 'SSH'], [23, 'Telnet'], [25, 'SMTP'],
  [53, 'DNS'], [67, 'DHCP'], [68, 'DHCP'], [69, 'TFTP'], [80, 'HTTP'],
  [110, 'POP3'], [111, 'RPC'], [119, 'NNTP'], [123, 'NTP'], [135, 'MS-RPC'],
  [137, 'NetBIOS'], [138, 'NetBIOS'], [139, 'NetBIOS'], [143, 'IMAP'],
  [161, 'SNMP'], [162, 'SNMP-trap'], [179, 'BGP'], [389, 'LDAP'], [443, 'HTTPS'],
  [445, 'SMB'], [465, 'SMTPS'], [500, 'IKE / IPsec'], [514, 'Syslog'],
  [515, 'LPD / printer'], [520, 'RIP'], [546, 'DHCPv6'], [547, 'DHCPv6'],
  [587, 'SMTP (submission)'], [636, 'LDAPS'], [853, 'DNS-over-TLS'],
  [873, 'rsync'], [989, 'FTPS-data'], [990, 'FTPS'], [993, 'IMAPS'],
  [995, 'POP3S'], [1080, 'SOCKS proxy'], [1194, 'OpenVPN'], [1433, 'MS SQL'],
  [1521, 'Oracle DB'], [1701, 'L2TP'], [1723, 'PPTP'], [1812, 'RADIUS'],
  [1813, 'RADIUS'], [1900, 'SSDP / UPnP'], [2049, 'NFS'], [2082, 'cPanel'],
  [3306, 'MySQL'], [3389, 'RDP'], [4500, 'IPsec NAT-T'], [5060, 'SIP'],
  [5061, 'SIP-TLS'], [5222, 'XMPP'], [5353, 'mDNS'], [5432, 'PostgreSQL'],
  [5900, 'VNC'], [5985, 'WinRM'], [5986, 'WinRM (TLS)'], [6379, 'Redis'],
  [8080, 'HTTP-alt'], [8443, 'HTTPS-alt'], [8883, 'MQTT (TLS)'], [9090, 'HTTP-alt'],
  [9200, 'Elasticsearch'], [11211, 'memcached'], [27017, 'MongoDB'],
  [51820, 'WireGuard'],
]);

// A few ports mean different things per transport; refine the name when we know
// the protocol. QUIC/HTTP-3 rides UDP/443; DNS is DNS on both 53/tcp and 53/udp.
const BY_PROTO = new Map([
  ['443/udp', 'HTTP/3 (QUIC)'],
  ['80/udp', 'HTTP/3 (QUIC)'],
]);

// Returns a human service name for a port ("HTTPS"), or null when the port is
// unknown or invalid. `proto` (optional) refines a few dual-use ports. Never
// throws — bad input yields null.
//
// Only ports in the explicit well-known list are named; everything else (an
// unknown service, or an ephemeral/dynamic client socket like 54018) falls
// through to null, so the UI shows "–" rather than a misleading guess. A couple
// of well-known ports (e.g. WireGuard/51820) legitimately sit in the dynamic
// range — the explicit list still names them.
function serviceForPort(port, proto) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  const t = String(proto || '').trim().toLowerCase();
  if (t) {
    const refined = BY_PROTO.get(`${p}/${t}`);
    if (refined) return refined;
  }
  return WELL_KNOWN.get(p) || null;
}

// Enriches a byPort summary row array ([{ port, proto, bytes, flowCount }]) with
// a `service` field. Copies rows so callers keep their originals.
function labelPorts(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ ...r, service: serviceForPort(r.port, r.proto) }));
}

module.exports = { WELL_KNOWN, serviceForPort, labelPorts };
