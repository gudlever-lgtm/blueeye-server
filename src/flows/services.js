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
  // Industrial / OT (ICS) protocols. Named so a PLC<->SCADA conversation reads
  // "Modbus/TCP" rather than "502". Each port is the IANA registration unless
  // marked "vendor default" (the vendor's documented factory port, which IANA
  // has registered to something else or not at all). Matches the 'ot' traffic
  // category in categories.js. Ports that are only a configurable convention
  // (e.g. Mitsubishi MELSEC's 5006/5007) are deliberately NOT listed: naming
  // them would be a guess dressed as a fact.
  [102, 'S7comm / ISO-TSAP (Siemens, IEC 61850 MMS)'], // IANA iso-tsap (RFC 1006)
  [502, 'Modbus/TCP'], // IANA mbap
  [1883, 'MQTT'], // IANA mqtt
  [1911, 'Niagara Fox'], // vendor default (Tridium Niagara; IANA lists 1911 as mtp)
  [2404, 'IEC 60870-5-104'], // IANA iec-104
  [4840, 'OPC UA'], // IANA opcua-tcp
  [9600, 'OMRON FINS'], // vendor default (Omron FINS/UDP; IANA lists 9600 as micromuse-ncpw)
  [18245, 'GE SRTP'], // vendor default (GE Fanuc/Emerson PLC SRTP)
  [20000, 'DNP3'], // IANA dnp
  [34962, 'PROFINET RT'], // IANA profinet-rt
  [34963, 'PROFINET RTM'], // IANA profinet-rtm
  [34964, 'PROFINET CM'], // IANA profinet-cm
  [44818, 'EtherNet/IP (CIP)'], // IANA EtherNet-IP-2 (explicit messaging)
  [47808, 'BACnet/IP'], // IANA bacnet (0xBAC0)
]);

// A few ports mean different things per transport; refine the name when we know
// the protocol. QUIC/HTTP-3 rides UDP/443; DNS is DNS on both 53/tcp and 53/udp.
//
// EtherNet/IP implicit (I/O) messaging is IANA EtherNet-IP-1 on 2222/udp. It is
// named ONLY for udp: 2222/tcp is far more often an alternate SSH port than a
// PLC, and a confident "EtherNet/IP" on somebody's SSH jump host would mislead.
const BY_PROTO = new Map([
  ['443/udp', 'HTTP/3 (QUIC)'],
  ['80/udp', 'HTTP/3 (QUIC)'],
  ['2222/udp', 'EtherNet/IP I/O'],
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

// Which end of a conversation is the SERVICE. A flow record carries both ports,
// and the direction a record was sampled in says nothing about which side is
// the server: the PLC's reply to a SCADA poll has src_port 502 and an ephemeral
// dst_port. The rule, in order, and mirrored in SQL by
// flowsRepository.topologyEdges so both answer the same:
//   1. dst_port is a named port (WELL_KNOWN)      -> dst_port
//   2. src_port is a named port                   -> src_port
//   3. otherwise the LOWER of the two             (a server port is conventionally
//                                                  below the client's ephemeral one)
// A missing port on one side yields the other; both missing (ICMP, GRE) -> null.
function validPort(v) {
  if (v === null || v === undefined || v === '') return null;
  const p = Number(v);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : null;
}
function servicePortOf(srcPort, dstPort) {
  const s = validPort(srcPort);
  const d = validPort(dstPort);
  if (d == null) return s;
  if (s == null) return d;
  if (WELL_KNOWN.has(d)) return d;
  if (WELL_KNOWN.has(s)) return s;
  return Math.min(s, d);
}

// Enriches a byPort summary row array ([{ port, proto, bytes, flowCount }]) with
// a `service` field. Copies rows so callers keep their originals.
function labelPorts(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ ...r, service: serviceForPort(r.port, r.proto) }));
}

module.exports = { WELL_KNOWN, serviceForPort, servicePortOf, labelPorts };
