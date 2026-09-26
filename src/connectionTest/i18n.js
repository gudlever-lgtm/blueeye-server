'use strict';

// Server-side translation for the ladder's sentences.
//
// Why not public/i18n.js: that is the browser's catalogue and keeps ONE active
// locale in module state. The ladder is rendered on the server, for several
// users at once, so a shared "current locale" would let one request's language
// leak into another's verdict. Here the locale is a parameter, exactly as
// src/nis2/i18n.js does it for the report documents. The machinery is repeated
// rather than imported because coupling the Connection test to the NIS2
// reporting module would be a worse trade than twenty lines of lookup.
//
// THE RULE ON TECHNICAL TERMS. Protocol and product names are NOT translated,
// in any locale: DNS, ARP, ICMP, TCP, SYN, RST, TLS, ACL, MTU, HTTP, NAT, VIP,
// firewall, load balancer, proxy, security group, ping, traceroute, reset,
// timeout. They are what the equipment, its documentation and the engineer all
// call them, and a Danish word for SYN would make a sentence harder to act on,
// not easier. Everything around them is the local language.
//
// What is deliberately NOT translated either: a clause the AGENT wrote
// (`detail` — "connect ECONNREFUSED 93.184.216.34:80", "certificate expired 3
// days ago"). It is a measurement in the words of the thing that measured it,
// the probe table already shows it as-is, and rewriting it here would create a
// second version of a string an operator may need to match against a log. The
// sentence AROUND it is translated; the clause is quoted.

const LOCALES = Object.freeze(['en', 'da']);
const DEFAULT_LOCALE = 'en';

const STRINGS = {
  en: {
    // --- layer names, as they appear inside a verdict sentence
    'layer.dns': 'DNS',
    'layer.arp': 'ARP',
    'layer.routing': 'routing',
    'layer.firewall': 'the firewall',
    'layer.tcp': 'the TCP handshake',
    'layer.nat_lb': 'NAT / load balancer',
    'layer.tls': 'TLS',
    'layer.application': 'the application',

    // --- DNS
    'dns.na': '{host} is an address, so there is no name to resolve',
    'dns.untested': 'no DNS lookup was run against this name',
    'dns.ok': 'the name resolved in {rtt} ms',
    'dns.ok.via': 'the name resolved in {rtt} ms via {resolver}',
    'dns.failed': 'the name did not resolve. Nothing above this rung was ever addressed',
    'dns.failed.code': 'the name did not resolve ({code}). Nothing above this rung was ever addressed',
    'dns.failed.via': 'the name did not resolve — resolver {resolver}. Nothing above this rung was ever addressed',
    'dns.failed.code_via': 'the name did not resolve ({code}) — resolver {resolver}. Nothing above this rung was ever addressed',

    // --- ARP
    'arp.name': 'ARP resolves addresses, not names — this rung is answered once the name has resolved to an address on the local segment',
    'arp.unknown.none': "nothing is known about this address's neighbour table, so whether ARP is on the path to it cannot be said",
    'arp.na.remote': "{host} is not on the agent's own segment, so the packet goes to the gateway and this address is never ARPed",
    'arp.unknown.segments': 'the agent has not reported which segments it is on, so whether ARP is on the path to this address cannot be said',
    'arp.ok': '{host} is at {mac}',
    'arp.ok.seen': '{host} is at {mac} (seen by {source}), last seen {lastSeen}',
    'arp.failed': "{host} is on the agent's segment and no MAC has ever been reported for it — nothing on this segment answered for that address",

    // --- routing
    'routing.untested': 'no traceroute was run, so the path was never walked',
    'routing.nohops': 'the traceroute returned no hops',
    'routing.failed': 'the path loses packets from hop {hop} onwards and never reaches {host}',
    'routing.suspect.loss': 'the path reaches {host} but loses packets from hop {hop} onwards',
    'routing.suspect.noreply': 'the trace ran {hops} hops without the destination answering — normal where the last hop filters ICMP, so this alone is not a break',
    'routing.ok': '{hops} hops to {host}, no sustained loss',

    // --- firewall / ACL
    'firewall.untested.both': 'neither ICMP nor a TCP port was tested, so nothing can be said about filtering',
    'firewall.untested.noping': 'no ping was run, so a TCP failure cannot be told apart from a host that is down',
    'firewall.untested.noports': 'no TCP port was tested, so a filter that permits ICMP and denies the application port would not show',
    'firewall.failed.one': 'ICMP is answered and TCP/{ports} is dropped in silence — a firewall rule, an ACL or a security group permitting ping and denying the application port. A host that was down could not answer the ping',
    'firewall.failed.many': 'ICMP is answered and TCP/{ports} are dropped in silence — a firewall rule, an ACL or a security group permitting ping and denying the application port. A host that was down could not answer the ping',
    'firewall.ok.refused': 'ICMP is answered and TCP/{ports} came back refused — a reset is the host answering, so nothing is filtering. The port is closed, which is the service’s problem and not the network’s',
    'firewall.suspect.icmp': 'ping does not come back but TCP/{ports} connects — ICMP is filtered somewhere and the application path is open. An ICMP-only monitor calls this an outage; it is not one',
    'firewall.unknown.bothdown': 'neither ICMP nor TCP comes back — both directions are broken, so this is the path rather than a rule that permits one and denies the other',
    'firewall.unknown.unclassified': 'TCP/{ports} failed and the agent did not report how, so a drop cannot be told from a reset (update the agent for refused/timeout)',
    'firewall.ok': 'ICMP is answered and TCP/{ports} connects — nothing between the agent and the destination is filtering either',

    // --- TCP
    'tcp.untested': 'no TCP port was tested',
    'tcp.ok': 'the handshake completes on TCP/{ports} in {rtt} ms',
    'tcp.ok.partial': 'the handshake completes on TCP/{ports} in {rtt} ms (TCP/{shut} did not)',
    'tcp.failed': 'no handshake completed — TCP/{detail}',

    // --- NAT / load balancer
    'natlb.untested': 'the ICMP and TCP paths were not both walked, so whether something answers for the destination cannot be said. Not the same as nothing being there',
    'natlb.suspect': '{evidence}. Whatever answers above this rung may be the middlebox rather than the service behind it',
    'lb.divergence': 'ICMP ends at {icmpIp} (hop {icmpHop}), the TCP session ends at {tcpIp} (hop {tcpHop}) — something terminates the connection before the host that answers ping',
    'lb.agree': 'both paths end at {ip} — nothing between the agent and the destination is terminating the session',
    'lb.multihop': '{count} addresses answered at hop {hop} of the {path} path ({ips}) — the traffic is balanced across them, so one test speaks for one of them',
    'lb.cert': 'the certificate does not carry {want} — a shared front end answered for a name it does not serve',
    'lb.cert.subject': 'the certificate does not carry {want} (it is for {subject}) — a shared front end answered for a name it does not serve',
    'lb.gateway': 'HTTP {status} ({phrase}) — a gateway answered for an upstream that did not. Nothing was inspected; the status names the shape of what produced it',

    // --- TLS
    'tls.untested': 'no TLS handshake was attempted',
    'tls.suspect.expiry': 'the handshake completes and the certificate is valid, but it expires in {days} days',
    'tls.ok': 'the handshake completes and the certificate is valid',
    'tls.ok.days': 'the handshake completes and the certificate is valid for another {days} days',
    'tls.failed': 'the TLS handshake did not complete: {detail}',
    'tls.failed.nodetail': 'the TLS handshake did not complete',

    // --- application
    'app.untested': 'the service itself was never asked for anything — every rung below only proves the packets arrive',
    'app.ok': 'the service answered HTTP {status} in {rtt} ms',
    'app.failed.norequest': 'the request did not complete — nothing answered on the application port',
    'app.failed.norequest.detail': 'the request did not complete: {detail}',
    'app.failed.5xx': 'the service answered HTTP {status} — it reached the code and the code failed',
    'app.failed.4xx': 'the service answered HTTP {status} — it is running and it refused the request',
    'app.failed.other': 'the service answered HTTP {status}',

    // --- the walk itself
    'rung.unreached': 'not reached — the communication already stops at {layer}',
    'rung.disabled': 'switched off in Settings, so it was not tested — nothing here says the layer is healthy',
    'verdict.stops': 'The communication stops at {layer}: {because}.',
    'verdict.stops.also': 'The communication stops at {layer}: {because}. Also worth knowing — {also}.',
    'verdict.stops.local_host': 'This host fails at {layer}: {because}.',
    'verdict.stops.also.local_host': 'This host fails at {layer}: {because}. Also worth knowing — {also}.',
    'verdict.stops.two_way': 'The fault is in {layer}: {because}.',
    'verdict.stops.also.two_way': 'The fault is in {layer}: {because}. Also worth knowing — {also}.',
    'verdict.stops.device_location': 'The trail ends at {layer}: {because}.',
    'verdict.stops.also.device_location': 'The trail ends at {layer}: {because}. Also worth knowing — {also}.',
    'verdict.untested': 'Nothing has been measured against this destination yet, so there is no verdict — run the ladder.',
    'verdict.suspect': 'No rung that was measured is broken. {suspects}.',
    'verdict.suspect.untested': 'No rung that was measured is broken. {suspects}. {untested} was not tested.',
    'verdict.suspect.untested.many': 'No rung that was measured is broken. {suspects}. {untested} were not tested.',
    'verdict.partial': 'Every rung that was measured is healthy. {untested} was not tested, so the ladder is not complete.',
    'verdict.partial.many': 'Every rung that was measured is healthy. {untested} were not tested, so the ladder is not complete.',
    'verdict.clear': 'Every rung answered and none of them is broken — the fault is not on the path to this destination.',
    'verdict.clear.local_host': 'Every rung answered and none of them is broken — this host is not the problem.',
    'verdict.clear.two_way': 'Both directions answered and neither is broken — the link between these two is not the problem.',
    'verdict.clear.device_location': 'The device was found, and the port it is on is healthy.',

    // ===== ladder: two_way =====
    'layer.forward': 'the forward direction',
    'layer.reverse': 'the return direction',
    'layer.symmetry': 'path symmetry',
    'layer.direction': 'the direction of loss',
    'layer.latency': 'round-trip time',
    'layer.mtu': 'path MTU',

    'forward.untested': '{from} was not asked to reach {to}',
    'forward.ok': '{from} reaches {to} — {loss}% loss, {rtt} ms',
    'forward.failed': 'nothing comes back when {from} probes {to}',
    'reverse.untested': '{from} was not asked to reach {to}, so only one direction has been measured',
    'reverse.ok': '{from} reaches {to} — {loss}% loss, {rtt} ms',
    'reverse.failed': 'nothing comes back when {from} probes {to}. One direction works and this one does not, which a test from either end alone reports as the far end being down',
    'symmetry.untested': 'only one direction was traced, so the two paths cannot be compared',
    'symmetry.nohops': 'neither trace returned hops to compare',
    'symmetry.ok': 'the two directions traverse the same routers ({pct}% of the shorter path lines up)',
    'symmetry.differs': 'the two directions take different paths — {pct}% of the shorter path lines up, {forward} hops out against {reverse} back. Normal on the internet and across most WANs; it matters when one direction is also losing, because the fault is then only on that path',
    'direction.untested': 'loss was not measured in both directions',
    'direction.ok': 'neither direction is losing ({forward}% out, {reverse}% back)',
    'direction.forward': '{from} → {to} loses {loss}% and the return direction is clean. The fault is on the outbound path, and a test run at {to} will report that everything is fine',
    'direction.reverse': '{to} → {from} loses {loss}% and the outbound direction is clean. The fault is on the return path — a stateful firewall that never saw the outbound SYN drops the answer exactly like this, and from {from} it looks like a dead service',
    'direction.both': 'both directions are losing — {forward}% out, {reverse}% back. That is the link or the host, not a rule that treats one direction differently',
    'latency.untested': 'round-trip time was not measured in both directions',
    'latency.ok': 'the two round trips cost about the same ({forward} ms and {reverse} ms)',
    'latency.differs': 'the two round trips cost materially different time \u2014 {forward} ms one way round, {reverse} ms the other, a gap of {diff} ms. Both are ROUND trips, so this is not one leg being slow: it is the two directions not taking the same path',
    'mtu.untested': 'path MTU was not measured in both directions',
    'mtu.ok': 'both directions carry {mtu} bytes',
    'mtu.differs': 'the two directions carry different packet sizes \u2014 {forward} bytes out, {reverse} bytes back. A request that fits and a reply that does not is what this looks like from the application; clamp to {smaller}',

    // ===== ladder: local_host =====
    'layer.link': 'the link',
    'layer.duplex': 'duplex',
    'layer.errors': 'interface errors',
    'layer.dhcp': 'DHCP',
    'layer.gateway': 'the gateway',
    'layer.resolver': 'the resolver',

    'link.untested': 'no interface has been reported for this agent',
    'link.down': '{iface} has no carrier — nothing above this rung is reachable from this host',
    'link.up': '{iface} has carrier',
    'link.up.speed': '{iface} has carrier at {speed} Mbps',
    'link.unreported': 'whether {iface} has carrier was not reported',
    'duplex.untested': 'no interface has been reported for this agent',
    'duplex.late': '{iface} is counting late collisions ({rate}/s) — one end may transmit while the other is transmitting, which only happens when the two disagree about duplex. This is a mismatch, not congestion',
    'duplex.half': '{iface} negotiated half duplex. On a switched port that is a negotiation that failed, and it behaves as a network fault that gets worse under load',
    'duplex.full': '{iface} is full duplex',
    'duplex.unreported': "{iface}'s duplex was not reported — many sources cannot read it, and not being able to look is not the same as nothing being wrong",
    'errors.untested': 'no interface has been reported for this agent',
    'errors.unreported': 'no error or discard counters were reported for {iface}',
    'errors.idle': '{iface} is erring at {rate}/s while only {util}% busy — a link that corrupts frames when it is barely loaded is a cable, an SFP or a duplex mismatch, never congestion',
    'errors.busy': '{iface} is erring at {rate}/s at {util}% utilisation',
    'errors.drops': '{iface} is discarding {rate}/s at {util}% utilisation',
    'errors.clean': '{iface} is not erring or discarding',
    'dhcp.untested': 'no DHCP test was run from this host',
    'dhcp.cannotrun': 'the DHCP test could not run, so it says nothing about the network',
    'dhcp.cannotrun.detail': 'the DHCP test could not run: {detail}. That says nothing about the network',
    'dhcp.none': 'nobody answered a DHCPDISCOVER on this segment. Existing leases keep working until they expire; a device that reboots or is plugged in now gets no address',
    'dhcp.several': '{count} different DHCP servers answered one DISCOVER ({servers}). Whichever answers first hands out the default gateway and the resolver, so this is a security finding as much as an availability one',
    'dhcp.one': 'one DHCP server answered ({server})',
    'gateway.untested': 'no traceroute was run, so the first hop was never asked',
    'gateway.silent': 'the first hop did not answer at all — the default gateway is not responding to this host',
    'gateway.lossy': 'the gateway {ip} loses {loss}% of what is sent to it',
    'gateway.someloss': 'the gateway {ip} answers {loss}% short. A router rate-limiting its OWN ICMP replies while forwarding everything else perfectly looks exactly like this, so it is worth knowing and not a fault on its own',
    'gateway.ok': 'the gateway {ip} answers in {rtt} ms',
    'resolver.untested': 'no DNS lookup was run from this host',
    'resolver.failed': 'the resolver {resolver} did not answer',
    'resolver.failed.code': 'the resolver {resolver} did not answer ({code})',
    'resolver.slow': 'the resolver {resolver} takes {rtt} ms. Every application above it experiences that as the network being broken',
    'resolver.ok': 'the resolver {resolver} answers in {rtt} ms',

    // ===== ladder: device_location =====
    'layer.identity': 'identity',
    'layer.switch': 'the switch',
    'layer.port': 'the port',
    'layer.state': 'port state',
    'layer.counters': 'port counters',
    'layer.vlan': 'VLAN',

    'identity.unknown': 'nothing this server has read knows {q} — no agent, switch, ARP table, forwarding table or discovery record',
    'identity.nomac': 'no ARP table this server reads maps {q} to a MAC address, so it cannot be looked up in any forwarding table. That is a coverage gap on that segment, not a missing device',
    'identity.ok': '{q} is at {mac}',
    'identity.ok.vendor': '{q} is at {mac} ({vendor})',
    'switch.nomac': 'there is no MAC to look up',
    'switch.notfound': 'no forwarding table read by this server holds {mac} — the switches in front of it are not polled here',
    'switch.self': '{name} is a switch this server polls, so it is its own location',
    'switch.ok': '{mac} is known to {name}',
    'port.nolocation': 'no switch holds this MAC, so there is no port to name',
    'port.self': 'the device IS the switch — there is no access port to look at',
    'port.noport': '{name} knows the MAC but reported no port for it',
    'port.shared': '{count} MAC addresses are behind {port} on {name}, so it is an uplink or a trunk rather than where this device is plugged in — it is the direction the device lies in',
    'port.ok': '{port} on {name}',
    'state.self': 'the device is the switch itself',
    'state.untested': 'the port was found but its state was not read',
    'state.notpolled': '{port} is not in this switch\u2019s polled interface list, so its state is unknown',
    'state.admindown': '{port} is administratively down — somebody shut it, which is a different job from a port that fell over',
    'state.operdown': '{port} is down',
    'state.up': '{port} is up',
    'state.up.speed': '{port} is up at {speed} Mbps',
    'state.unreported': '{port} did not report an operational state',
    'counters.self': 'the device is the switch itself',
    'counters.untested': 'no counters have been polled for this port',
    'counters.unreported': '{port} reported no error or discard counters',
    'counters.errors': '{port} is erring at {rate}/s at {util}% utilisation',
    'counters.discards': '{port} is discarding {rate}/s at {util}% utilisation',
    'counters.clean': '{port} is not erring or discarding',
    'vlan.self': 'the device is the switch itself',
    'vlan.nolocation': 'no port was found, so there is no VLAN to report',
    'vlan.unreported': 'the forwarding table entry for {port} carries no VLAN',
    'vlan.wrong': 'the device is on VLAN {vlan}, and it was expected on {expected}',
    'vlan.ok': 'VLAN {vlan}',
    'vlan.ok.name': 'VLAN {vlan} ({name})',
  },

  da: {
    'layer.dns': 'DNS',
    'layer.arp': 'ARP',
    'layer.routing': 'routing',
    'layer.firewall': 'firewallen',
    'layer.tcp': 'TCP-håndtrykket',
    'layer.nat_lb': 'NAT / load balancer',
    'layer.tls': 'TLS',
    'layer.application': 'applikationen',

    'dns.na': '{host} er en adresse, så der er ikke noget navn at slå op',
    'dns.untested': 'der er ikke kørt et DNS-opslag mod dette navn',
    'dns.ok': 'navnet blev slået op på {rtt} ms',
    'dns.ok.via': 'navnet blev slået op på {rtt} ms via {resolver}',
    'dns.failed': 'navnet kunne ikke slås op. Intet over dette trin er nogensinde blevet adresseret',
    'dns.failed.code': 'navnet kunne ikke slås op ({code}). Intet over dette trin er nogensinde blevet adresseret',
    'dns.failed.via': 'navnet kunne ikke slås op — resolver {resolver}. Intet over dette trin er nogensinde blevet adresseret',
    'dns.failed.code_via': 'navnet kunne ikke slås op ({code}) — resolver {resolver}. Intet over dette trin er nogensinde blevet adresseret',

    'arp.name': 'ARP slår adresser op, ikke navne — dette trin besvares, når navnet er slået op til en adresse på det lokale segment',
    'arp.unknown.none': 'der vides intet om denne adresses neighbour table, så det kan ikke siges, om ARP overhovedet er på vejen til den',
    'arp.na.remote': '{host} er ikke på agentens eget segment, så pakken sendes til gatewayen, og der bliver aldrig ARPet efter denne adresse',
    'arp.unknown.segments': 'agenten har ikke rapporteret hvilke segmenter den sidder på, så det kan ikke siges, om ARP er på vejen til denne adresse',
    'arp.ok': '{host} sidder på {mac}',
    'arp.ok.seen': '{host} sidder på {mac} (set af {source}), sidst set {lastSeen}',
    'arp.failed': '{host} er på agentens segment, og der er aldrig rapporteret en MAC for den — intet på dette segment svarede for den adresse',

    'routing.untested': 'der er ikke kørt en traceroute, så vejen er aldrig gået igennem',
    'routing.nohops': 'traceroute returnerede ingen hop',
    'routing.failed': 'vejen taber pakker fra hop {hop} og frem og når aldrig {host}',
    'routing.suspect.loss': 'vejen når {host}, men taber pakker fra hop {hop} og frem',
    'routing.suspect.noreply': 'sporingen kørte {hops} hop uden at destinationen svarede — normalt hvor sidste hop filtrerer ICMP, så det alene er ikke et brud',
    'routing.ok': '{hops} hop til {host}, intet vedvarende tab',

    'firewall.untested.both': 'hverken ICMP eller en TCP-port er testet, så der kan ikke siges noget om filtrering',
    'firewall.untested.noping': 'der er ikke kørt ping, så en TCP-fejl kan ikke skelnes fra en vært der er nede',
    'firewall.untested.noports': 'der er ikke testet en TCP-port, så et filter der tillader ICMP og nægter applikationsporten ville ikke vise sig',
    'firewall.failed.one': 'ICMP besvares, og TCP/{ports} droppes lydløst — en firewall-regel, en ACL eller en security group der tillader ping og nægter applikationsporten. En vært der var nede kunne ikke have svaret på ping',
    'firewall.failed.many': 'ICMP besvares, og TCP/{ports} droppes lydløst — en firewall-regel, en ACL eller en security group der tillader ping og nægter applikationsporten. En vært der var nede kunne ikke have svaret på ping',
    'firewall.ok.refused': 'ICMP besvares, og TCP/{ports} kom tilbage som refused — en reset er værten der svarer, så der filtreres ikke. Porten er lukket, hvilket er tjenestens problem og ikke netværkets',
    'firewall.suspect.icmp': 'ping kommer ikke tilbage, men TCP/{ports} forbinder — ICMP filtreres et sted, og applikationsvejen er åben. En monitor der kun bruger ICMP kalder dette et nedbrud; det er det ikke',
    'firewall.unknown.bothdown': 'hverken ICMP eller TCP kommer tilbage — begge retninger er i stykker, så dette er vejen og ikke en regel der tillader den ene og nægter den anden',
    'firewall.unknown.unclassified': 'TCP/{ports} fejlede, og agenten rapporterede ikke hvordan, så et drop kan ikke skelnes fra en reset (opdatér agenten for refused/timeout)',
    'firewall.ok': 'ICMP besvares, og TCP/{ports} forbinder — intet mellem agenten og destinationen filtrerer nogen af delene',

    'tcp.untested': 'der er ikke testet en TCP-port',
    'tcp.ok': 'håndtrykket fuldføres på TCP/{ports} på {rtt} ms',
    'tcp.ok.partial': 'håndtrykket fuldføres på TCP/{ports} på {rtt} ms (TCP/{shut} gjorde ikke)',
    'tcp.failed': 'intet håndtryk blev fuldført — TCP/{detail}',

    'natlb.untested': 'ICMP-vejen og TCP-vejen er ikke begge gået igennem, så det kan ikke siges, om noget svarer på destinationens vegne. Det er ikke det samme som at der intet er',
    'natlb.suspect': '{evidence}. Det der svarer over dette trin kan være mellemleddet og ikke tjenesten bagved',
    'lb.divergence': 'ICMP ender på {icmpIp} (hop {icmpHop}), TCP-sessionen ender på {tcpIp} (hop {tcpHop}) — noget afslutter forbindelsen før den vært der svarer på ping',
    'lb.agree': 'begge veje ender på {ip} — intet mellem agenten og destinationen afslutter sessionen',
    'lb.multihop': '{count} adresser svarede på hop {hop} af {path}-vejen ({ips}) — trafikken fordeles mellem dem, så én test taler for én af dem',
    'lb.cert': 'certifikatet bærer ikke {want} — et delt frontend svarede for et navn det ikke betjener',
    'lb.cert.subject': 'certifikatet bærer ikke {want} (det er til {subject}) — et delt frontend svarede for et navn det ikke betjener',
    'lb.gateway': 'HTTP {status} ({phrase}) — en gateway svarede for en upstream der ikke gjorde. Intet er blevet undersøgt; statuskoden navngiver formen på det der frembragte den',

    'tls.untested': 'der er ikke forsøgt et TLS-håndtryk',
    'tls.suspect.expiry': 'håndtrykket fuldføres, og certifikatet er gyldigt, men det udløber om {days} dage',
    'tls.ok': 'håndtrykket fuldføres, og certifikatet er gyldigt',
    'tls.ok.days': 'håndtrykket fuldføres, og certifikatet er gyldigt {days} dage endnu',
    'tls.failed': 'TLS-håndtrykket blev ikke fuldført: {detail}',
    'tls.failed.nodetail': 'TLS-håndtrykket blev ikke fuldført',

    'app.untested': 'tjenesten selv er aldrig blevet bedt om noget — alle trin nedenunder viser kun, at pakkerne kommer frem',
    'app.ok': 'tjenesten svarede HTTP {status} på {rtt} ms',
    'app.failed.norequest': 'forespørgslen blev ikke fuldført — intet svarede på applikationsporten',
    'app.failed.norequest.detail': 'forespørgslen blev ikke fuldført: {detail}',
    'app.failed.5xx': 'tjenesten svarede HTTP {status} — den nåede frem til koden, og koden fejlede',
    'app.failed.4xx': 'tjenesten svarede HTTP {status} — den kører, og den afviste forespørgslen',
    'app.failed.other': 'tjenesten svarede HTTP {status}',

    'rung.unreached': 'ikke nået — kommunikationen stopper allerede ved {layer}',
    'rung.disabled': 'slået fra under Indstillinger, så der er ikke testet — intet her siger, at laget er sundt',
    'verdict.stops': 'Kommunikationen stopper ved {layer}: {because}.',
    'verdict.stops.also': 'Kommunikationen stopper ved {layer}: {because}. Også værd at vide — {also}.',
    'verdict.stops.local_host': 'Denne vært fejler ved {layer}: {because}.',
    'verdict.stops.also.local_host': 'Denne vært fejler ved {layer}: {because}. Også værd at vide — {also}.',
    'verdict.stops.two_way': 'Fejlen ligger i {layer}: {because}.',
    'verdict.stops.also.two_way': 'Fejlen ligger i {layer}: {because}. Også værd at vide — {also}.',
    'verdict.stops.device_location': 'Sporet ender ved {layer}: {because}.',
    'verdict.stops.also.device_location': 'Sporet ender ved {layer}: {because}. Også værd at vide — {also}.',
    'verdict.untested': 'Der er endnu ikke målt noget mod denne destination, så der er ingen dom — kør stigen.',
    'verdict.suspect': 'Intet målt trin er i stykker. {suspects}.',
    'verdict.suspect.untested': 'Intet målt trin er i stykker. {suspects}. {untested} blev ikke testet.',
    'verdict.suspect.untested.many': 'Intet målt trin er i stykker. {suspects}. {untested} blev ikke testet.',
    'verdict.partial': 'Alle målte trin er sunde. {untested} blev ikke testet, så stigen er ikke komplet.',
    'verdict.partial.many': 'Alle målte trin er sunde. {untested} blev ikke testet, så stigen er ikke komplet.',
    'verdict.clear': 'Alle trin svarede, og ingen af dem er i stykker — fejlen ligger ikke på vejen til denne destination.',
    'verdict.clear.local_host': 'Alle trin svarede, og ingen af dem er i stykker — denne vært er ikke problemet.',
    'verdict.clear.two_way': 'Begge retninger svarede, og ingen af dem er i stykker — forbindelsen mellem de to er ikke problemet.',
    'verdict.clear.device_location': 'Enheden blev fundet, og den port den sidder på er sund.',

    // ===== ladder: two_way =====
    'layer.forward': 'den udgående retning',
    'layer.reverse': 'returretningen',
    'layer.symmetry': 'vejsymmetri',
    'layer.direction': 'retningen tabet ligger i',
    'layer.latency': 'svartid tur-retur',
    'layer.mtu': 'path MTU',

    'forward.untested': '{from} er ikke blevet bedt om at nå {to}',
    'forward.ok': '{from} når {to} — {loss}% tab, {rtt} ms',
    'forward.failed': 'der kommer intet tilbage, når {from} prober {to}',
    'reverse.untested': '{from} er ikke blevet bedt om at nå {to}, så kun den ene retning er målt',
    'reverse.ok': '{from} når {to} — {loss}% tab, {rtt} ms',
    'reverse.failed': 'der kommer intet tilbage, når {from} prober {to}. Den ene retning virker, og denne gør ikke, hvilket en test fra hver ende alene vil melde som at den anden ende er nede',
    'symmetry.untested': 'kun den ene retning er sporet, så de to veje kan ikke sammenlignes',
    'symmetry.nohops': 'ingen af sporingerne returnerede hop der kan sammenlignes',
    'symmetry.ok': 'de to retninger går gennem de samme routere ({pct}% af den korteste vej passer)',
    'symmetry.differs': 'de to retninger tager forskellige veje — {pct}% af den korteste vej passer, {forward} hop ud mod {reverse} tilbage. Det er normalt på internettet og på de fleste WAN; det betyder noget, når den ene retning også taber, for så ligger fejlen kun på den vej',
    'direction.untested': 'tab er ikke målt i begge retninger',
    'direction.ok': 'ingen af retningerne taber ({forward}% ud, {reverse}% tilbage)',
    'direction.forward': '{from} → {to} taber {loss}%, og returretningen er ren. Fejlen ligger på den udgående vej, og en test kørt på {to} vil melde at alt er i orden',
    'direction.reverse': '{to} → {from} taber {loss}%, og den udgående retning er ren. Fejlen ligger på returvejen — en stateful firewall der aldrig så den udgående SYN dropper svaret på præcis denne måde, og fra {from} ligner det en død tjeneste',
    'direction.both': 'begge retninger taber — {forward}% ud, {reverse}% tilbage. Det er forbindelsen eller værten, ikke en regel der behandler den ene retning anderledes',
    'latency.untested': 'svartid er ikke målt i begge retninger',
    'latency.ok': 'de to tur-retur-målinger koster omtrent det samme ({forward} ms og {reverse} ms)',
    'latency.differs': 'de to tur-retur-målinger koster markant forskellig tid — {forward} ms den ene vej rundt, {reverse} ms den anden, en forskel på {diff} ms. Begge er TUR-RETUR, så det er ikke det ene ben der er langsomt: det er de to retninger der ikke tager samme vej',
    'mtu.untested': 'path MTU er ikke målt i begge retninger',
    'mtu.ok': 'begge retninger bærer {mtu} bytes',
    'mtu.differs': 'de to retninger bærer forskellige pakkestørrelser — {forward} bytes ud, {reverse} bytes tilbage. En forespørgsel der passer og et svar der ikke gør er sådan det ser ud fra applikationen; clamp til {smaller}',

    // ===== ladder: local_host =====
    'layer.link': 'forbindelsen',
    'layer.duplex': 'duplex',
    'layer.errors': 'interfacefejl',
    'layer.dhcp': 'DHCP',
    'layer.gateway': 'gatewayen',
    'layer.resolver': 'resolveren',

    'link.untested': 'der er ikke rapporteret et interface for denne agent',
    'link.down': '{iface} har ingen carrier — intet over dette trin kan nås fra denne vært',
    'link.up': '{iface} har carrier',
    'link.up.speed': '{iface} har carrier ved {speed} Mbps',
    'link.unreported': 'om {iface} har carrier blev ikke rapporteret',
    'duplex.untested': 'der er ikke rapporteret et interface for denne agent',
    'duplex.late': '{iface} tæller late collisions ({rate}/s) — den ene ende må sende, mens den anden sender, hvilket kun sker når de to er uenige om duplex. Det er en mismatch, ikke trængsel',
    'duplex.half': '{iface} forhandlede half duplex. På en switchet port er det en forhandling der mislykkedes, og det opfører sig som en netværksfejl der bliver værre under belastning',
    'duplex.full': '{iface} kører full duplex',
    'duplex.unreported': 'duplex for {iface} blev ikke rapporteret — mange kilder kan ikke læse det, og ikke at kunne se efter er ikke det samme som at der ikke er noget galt',
    'errors.untested': 'der er ikke rapporteret et interface for denne agent',
    'errors.unreported': 'der blev ikke rapporteret fejl- eller discard-tællere for {iface}',
    'errors.idle': '{iface} fejler {rate}/s, mens den kun er {util}% belastet — en forbindelse der ødelægger frames, når den næsten ingenting laver, er et kabel, en SFP eller en duplex-mismatch, aldrig trængsel',
    'errors.busy': '{iface} fejler {rate}/s ved {util}% belastning',
    'errors.drops': '{iface} smider {rate}/s væk ved {util}% belastning',
    'errors.clean': '{iface} fejler ikke og smider ikke pakker væk',
    'dhcp.untested': 'der er ikke kørt en DHCP-test fra denne vært',
    'dhcp.cannotrun': 'DHCP-testen kunne ikke køre, så den siger intet om netværket',
    'dhcp.cannotrun.detail': 'DHCP-testen kunne ikke køre: {detail}. Det siger intet om netværket',
    'dhcp.none': 'ingen svarede på en DHCPDISCOVER på dette segment. Eksisterende leases virker indtil de udløber; en enhed der genstarter eller sættes til nu får ingen adresse',
    'dhcp.several': '{count} forskellige DHCP-servere svarede på én DISCOVER ({servers}). Den der svarer først uddeler default gateway og resolver, så dette er lige så meget et sikkerhedsfund som et tilgængelighedsfund',
    'dhcp.one': 'én DHCP-server svarede ({server})',
    'gateway.untested': 'der er ikke kørt en traceroute, så første hop er aldrig blevet spurgt',
    'gateway.silent': 'første hop svarede slet ikke — default gateway svarer ikke denne vært',
    'gateway.lossy': 'gatewayen {ip} taber {loss}% af det der sendes til den',
    'gateway.someloss': 'gatewayen {ip} svarer {loss}% for lidt. En router der rate-limiter sine EGNE ICMP-svar, mens den viderestiller alt andet perfekt, ser præcis sådan ud, så det er værd at vide og ikke en fejl i sig selv',
    'gateway.ok': 'gatewayen {ip} svarer på {rtt} ms',
    'resolver.untested': 'der er ikke kørt et DNS-opslag fra denne vært',
    'resolver.failed': 'resolveren {resolver} svarede ikke',
    'resolver.failed.code': 'resolveren {resolver} svarede ikke ({code})',
    'resolver.slow': 'resolveren {resolver} bruger {rtt} ms. Enhver applikation ovenover oplever det som at netværket er i stykker',
    'resolver.ok': 'resolveren {resolver} svarer på {rtt} ms',

    // ===== ladder: device_location =====
    'layer.identity': 'identitet',
    'layer.switch': 'switchen',
    'layer.port': 'porten',
    'layer.state': 'portens tilstand',
    'layer.counters': 'portens tællere',
    'layer.vlan': 'VLAN',

    'identity.unknown': 'intet denne server har læst kender {q} — hverken agent, switch, ARP-tabel, forwarding table eller discovery-post',
    'identity.nomac': 'ingen ARP-tabel denne server læser knytter {q} til en MAC-adresse, så den kan ikke slås op i nogen forwarding table. Det er et dækningshul på det segment, ikke en manglende enhed',
    'identity.ok': '{q} sidder på {mac}',
    'identity.ok.vendor': '{q} sidder på {mac} ({vendor})',
    'switch.nomac': 'der er ingen MAC at slå op',
    'switch.notfound': 'ingen forwarding table læst af denne server indeholder {mac} — de switche der står foran den bliver ikke pollet her',
    'switch.self': '{name} er en switch denne server poller, så den er sin egen placering',
    'switch.ok': '{mac} er kendt af {name}',
    'port.nolocation': 'ingen switch har denne MAC, så der er ingen port at nævne',
    'port.self': 'enheden ER switchen — der er ingen adgangsport at se på',
    'port.noport': '{name} kender MAC-adressen, men rapporterede ingen port for den',
    'port.shared': 'der sidder {count} MAC-adresser bag {port} på {name}, så det er et uplink eller et trunk og ikke der hvor denne enhed er sat til — det er den retning enheden ligger i',
    'port.ok': '{port} på {name}',
    'state.self': 'enheden er selve switchen',
    'state.untested': 'porten blev fundet, men dens tilstand blev ikke læst',
    'state.notpolled': '{port} er ikke på denne switch\u2019 pollede interfaceliste, så dens tilstand er ukendt',
    'state.admindown': '{port} er administrativt nede — nogen har lukket den, og det er en anden opgave end en port der er faldet ud',
    'state.operdown': '{port} er nede',
    'state.up': '{port} er oppe',
    'state.up.speed': '{port} er oppe ved {speed} Mbps',
    'state.unreported': '{port} rapporterede ingen driftstilstand',
    'counters.self': 'enheden er selve switchen',
    'counters.untested': 'der er ikke pollet tællere for denne port',
    'counters.unreported': '{port} rapporterede ingen fejl- eller discard-tællere',
    'counters.errors': '{port} fejler {rate}/s ved {util}% belastning',
    'counters.discards': '{port} smider {rate}/s væk ved {util}% belastning',
    'counters.clean': '{port} fejler ikke og smider ikke pakker væk',
    'vlan.self': 'enheden er selve switchen',
    'vlan.nolocation': 'der blev ikke fundet en port, så der er intet VLAN at rapportere',
    'vlan.unreported': 'posten i forwarding table for {port} bærer intet VLAN',
    'vlan.wrong': 'enheden sidder på VLAN {vlan}, og den var forventet på {expected}',
    'vlan.ok': 'VLAN {vlan}',
    'vlan.ok.name': 'VLAN {vlan} ({name})',
  },
};

const isLocale = (v) => LOCALES.includes(String(v || '').toLowerCase());
const resolveLocale = (v) => (isLocale(v) ? String(v).toLowerCase() : DEFAULT_LOCALE);

// `{name}` substitution. A placeholder with no value is left as it is rather
// than rendered empty: a sentence with a visible {rtt} in it is a bug report,
// and a sentence with a hole in it is one nobody notices.
function interpolate(raw, params) {
  if (!params) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

function createT(locale) {
  const loc = resolveLocale(locale);
  const table = STRINGS[loc] || {};
  const fallback = STRINGS[DEFAULT_LOCALE];
  const t = (key, params) => {
    const k = String(key);
    const raw = Object.prototype.hasOwnProperty.call(table, k) ? table[k]
      : (Object.prototype.hasOwnProperty.call(fallback, k) ? fallback[k] : k);
    return interpolate(raw, params);
  };
  // Does a sentence exist for this key at all? A ladder may override a shared
  // verdict with one of its own ('verdict.clear.local_host'), and the walk asks
  // this before reaching for it — a missing override falls back to the shared
  // sentence rather than rendering the key.
  t.has = (key) => Object.prototype.hasOwnProperty.call(table, String(key))
    || Object.prototype.hasOwnProperty.call(fallback, String(key));
  t.locale = loc;
  return t;
}

// Keys present in one locale and missing from another. The parity test reads
// this, so a rung added with only an English sentence fails the build instead
// of quietly answering in English to a Danish operator.
function missingKeys() {
  const out = {};
  const all = new Set(Object.values(STRINGS).flatMap((s) => Object.keys(s)));
  for (const loc of LOCALES) {
    const missing = [...all].filter((k) => !Object.prototype.hasOwnProperty.call(STRINGS[loc], k));
    if (missing.length) out[loc] = missing;
  }
  return out;
}

module.exports = { LOCALES, DEFAULT_LOCALE, STRINGS, isLocale, resolveLocale, createT, missingKeys, interpolate };
