// public/about.js — the feature history the About page is built from.
//
// A dated record. Every entry carries the version it shipped in and the date
// that version landed on main, so the page answers two questions an operator
// actually asks: "what is this build?" and "when did the thing I am looking at
// arrive?".
//
// This file is the DATA. The screen that draws it is public/views/about.js,
// which is on the UI contract — keeping the two apart means a hundred history
// entries do not sit in the middle of a view module.
//
// The list is curated, not generated: 350+ version bumps are noise, and a
// changelog nobody can scan is a changelog nobody reads. One line per thing
// that changed what the product can do. The versions and dates are the real
// ones from the repository history — test/about.test.js checks the shape, the
// ordering and that nothing here claims to be newer than this build.
//
// Every string is { en, da }. Titles and one-liners are data rather than
// catalogue keys: a hundred history entries would drown public/i18n.js, and
// nothing outside this page ever names them. The page CHROME (headings,
// filters, the build line) does go through t(), like the rest of the UI.
//
// Loaded as its own classic script (no build step, repo convention).

(function (root) {
  'use strict';

  // The areas a change can belong to. Order is the filter-chip order. The
  // catalogue keys are written out rather than built from the area name: the UI
  // gate sweeps the keys the dashboard passes to the translator, and a key that
  // is glued together at runtime is one it cannot read — so it has to be
  // checked somewhere. test/about.test.js is where.
  var AREAS = ['monitoring', 'fleet', 'diagnostics', 'assurance', 'insights', 'platform'];
  var AREA_KEYS = {
    monitoring: 'about.area.monitoring',
    fleet: 'about.area.fleet',
    diagnostics: 'about.area.diagnostics',
    assurance: 'about.area.assurance',
    insights: 'about.area.insights',
    platform: 'about.area.platform',
  };

  // The history, newest first. v = the version it shipped in, d = the date that
  // version landed (YYYY-MM-DD, the page groups by month).
  var RELEASES = [
    { v: '0.173.0', d: '2026-09-20', area: 'monitoring',
      en: { t: 'What a switch port has been doing', s: 'Interface counters — errors, discards, utilisation, FCS errors, late collisions — are now collected per port per switch and kept over time, so an intermittent fault has a history instead of a snapshot. The hard part is knowing when NOT to compute a rate: a switch that rebooted between two polls, a port whose index moved when a module went in, a gap too long to mean anything. In each of those the subtraction produces a number, and the number is a lie — so the reading is kept, the rate is left out, and the row says which case it was.' },
      da: { t: 'Hvad en switchport har lavet', s: 'Interface-tællere — fejl, discards, udnyttelse, FCS-fejl, sene kollisioner — opsamles nu pr. port pr. switch og gemmes over tid, så en sporadisk fejl har en historik i stedet for et øjebliksbillede. Det svære er at vide hvornår man IKKE skal regne en rate ud: en switch der genstartede mellem to målinger, en port hvis indeks flyttede sig da et modul blev sat i, et hul der er for langt til at betyde noget. I alle de tilfælde giver subtraktionen et tal, og tallet er forkert — så aflæsningen gemmes, raten udelades, og rækken siger hvilket tilfælde det var.' } },
    { v: '0.172.0', d: '2026-09-20', area: 'monitoring',
      en: { t: 'A switch knows what ports it has', s: 'Every polled switch now keeps a list of its own ports — name, description, speed, whether somebody shut the port or it fell over on its own. The list is keyed on the port NAME rather than its SNMP index, because inserting a module into a chassis renumbers the indexes and would otherwise quietly mix two different physical ports together in the same history. SNMP also ships with the agent now, rather than being something that had to be installed by hand on every host.' },
      da: { t: 'En switch ved hvilke porte den har', s: 'Hver pollet switch fører nu sin egen portliste — navn, beskrivelse, hastighed, og om nogen har slukket porten eller den faldt ud af sig selv. Listen nøgles på portens NAVN og ikke på dens SNMP-indeks, fordi et nyt modul i en chassis-switch omnummererer indeksene og ellers stille ville blande to forskellige fysiske porte sammen i samme historik. SNMP følger også med agenten nu, i stedet for at skulle installeres i hånden på hver vært.' } },
    { v: '0.171.0', d: '2026-09-20', area: 'diagnostics',
      en: { t: 'Measure a fault while it is happening', s: 'Agents report once a minute and the baselines are hourly, so a five-second loss event never reached the data at all. Burst mode measures one target once a second for up to two minutes, draws the samples as they arrive, and then says what SHAPE the loss has: spread evenly, which reads as congestion or a bad cable, or arriving in groups, which points at something that recurs — a spanning-tree reconvergence, a link renegotiating, a scheduled job.' },
      da: { t: 'Mål en fejl mens den sker', s: 'Agenter rapporterer én gang i minuttet, og baselines regnes pr. time, så et fem sekunders tab aldrig nåede frem til data. Burst-tilstand måler ét mål én gang i sekundet i op til to minutter, tegner målingerne mens de kommer ind, og siger derefter hvilken FORM tabet har: jævnt fordelt, hvilket læses som belastning eller et dårligt kabel, eller i grupper, hvilket peger på noget der gentager sig — en spanning-tree-omlægning, et link der forhandler igen, et planlagt job.' } },
    { v: '0.170.0', d: '2026-09-20', area: 'diagnostics',
      en: { t: 'SNMP traps, on the same screen as the logs', s: 'UPSes, access points and older switches often send traps and no syslog at all \u2014 and a trap usually arrives a second or two before the log line about the same fault, because the device emits it from a different code path. Both now land in the same Device log, and a port that was shut on purpose is told apart from one that fell over.' },
      da: { t: 'SNMP-traps, p\u00e5 samme sk\u00e6rm som loggene', s: 'UPS\u2019er, accesspoints og \u00e6ldre switche sender ofte traps og slet ingen syslog \u2014 og en trap ankommer typisk et sekund eller to f\u00f8r logbeskeden om samme fejl, fordi enheden sender den fra en anden kodesti. Begge lander nu i den samme Enhedslog, og en port der er slukket med vilje skelnes fra en der faldt ud.' } },
    { v: '0.169.0', d: '2026-09-20', area: 'diagnostics',
      en: { t: 'Search a MAC address, get the switch port', s: 'An agent can now poll the switches on its network for their forwarding tables, so the question that used to end at "it is somewhere on this subnet" ends at "sw-acc-2, Gi0/14, VLAN 20 \u2014 and one device on that port, so walk to the patch panel". One agent covers a wiring closet instead of one switch, and a crowded port says it is probably an uplink rather than pretending to be an answer.' },
      da: { t: 'S\u00f8g p\u00e5 en MAC-adresse, f\u00e5 switchporten', s: 'En agent kan nu polle switchene p\u00e5 sit net for deres forwarding-tabeller, s\u00e5 sp\u00f8rgsm\u00e5let der f\u00f8r endte ved "den er et sted p\u00e5 dette subnet" nu ender ved "sw-acc-2, Gi0/14, VLAN 20 \u2014 og \u00e9n enhed p\u00e5 porten, s\u00e5 g\u00e5 hen til patchpanelet". \u00c9n agent d\u00e6kker et krydsfelt i stedet for \u00e9n switch, og en optaget port siger at den nok er et uplink i stedet for at lade som om den er et svar.' } },
    { v: '0.168.0', d: '2026-09-20', area: 'diagnostics',
      en: { t: 'The network equipment can finally speak for itself', s: 'Switches, firewalls and access points log their own faults — a port dropping, a spanning-tree change, an OSPF neighbour going away, a DHCP pool running dry. An agent on the customer network now receives those messages and puts them on the Device log, on the timeline beside the findings, and on the landing page when they matter. Nothing new leaves the site, and credentials are redacted before a line ever leaves the host.' },
      da: { t: 'Netværksudstyret kan endelig tale for sig selv', s: 'Switche, firewalls og accesspoints logger deres egne fejl — en port der falder ud, en spanning-tree-ændring, en OSPF-nabo der forsvinder, en DHCP-pulje der løber tør. En agent på kundens net modtager nu de beskeder og viser dem i Enhedsloggen, på tidslinjen ved siden af fundene, og på landingssiden når de betyder noget. Intet nyt forlader lokationen, og adgangskoder maskeres før en linje overhovedet forlader værten.' } },
    { v: '0.167.0', d: '2026-09-17', area: 'fleet',
      en: { t: 'Re-pinning an agent is done from the server', s: 'An agent that refuses updates because it trusts an older signing key is re-pinned over its own connection — one click, no shell on the host, no re-enrollment, and the refused update is retried straight after.' },
      da: { t: 'Fastlåsning af en agent sker fra serveren', s: 'En agent, der afviser opdateringer, fordi den stoler på en ældre signeringsnøgle, fastlåses på ny over sin egen forbindelse — ét klik, ingen kommandoer på værten, ingen ny tilmelding, og den afviste opdatering forsøges igen med det samme.' } },
    { v: '0.166.0', d: '2026-09-17', area: 'fleet',
      en: { t: 'An agent that refuses an update can be re-pinned', s: 'When an agent rejects a one-click update because the release key it trusts is no longer the one this server signs with, the dashboard says exactly why and hands over the one-liner that re-anchors that host — no re-install, no second agent.' },
      da: { t: 'En agent, der afviser en opdatering, kan fastlåses på ny', s: 'Når en agent afviser en et-kliks-opdatering, fordi den nøgle den stoler på, ikke længere er den, serveren signerer med, siger dashboardet præcis hvorfor og giver kommandoen, der fastlåser værten på ny — uden geninstallation og uden en ekstra agent.' } },
    { v: '0.161.0', d: '2026-09-17', area: 'platform',
      en: { t: 'An About page', s: 'The account menu answers what this build is, and what the product grew into: every feature that moved the needle, with the version it shipped in and the month it landed.' },
      da: { t: 'En Om-side', s: 'Kontomenuen svarer på, hvad denne version er, og hvad produktet er vokset til: hver funktion, der flyttede noget, med den version den kom i, og den måned den landede.' } },
    { v: '0.160.1', d: '2026-09-17', area: 'diagnostics',
      en: { t: 'TLS certificate and reverse-DNS probes', s: 'Two more things an agent can check from where it stands: how long a certificate has left, and whether an address resolves back to the name it claims.' },
      da: { t: 'TLS-certifikat- og reverse-DNS-probes', s: 'To nye ting en agent kan tjekke fra sin egen plads: hvor længe et certifikat holder, og om en adresse slår tilbage til det navn, den påstår.' } },
    { v: '0.159.1', d: '2026-09-17', area: 'platform',
      en: { t: 'Tabs look like tabs, and behave like them', s: 'One tab strip for the whole product — arrow keys, focus order and a screen reader that is told what the row is.' },
      da: { t: 'Faner ligner faner — og opfører sig som faner', s: 'Én fanelinje i hele produktet — piletaster, fokusrækkefølge og en skærmlæser, der får at vide, hvad rækken er.' } },
    { v: '0.158.1', d: '2026-09-17', area: 'diagnostics',
      en: { t: 'Connection test: one address, the whole battery', s: 'Type an address, get ping, TCP, DNS, HTTP, TLS and traceroute in one run — with repeat, rounds and a Stop button on every screen that runs something.' },
      da: { t: 'Forbindelsestest: én adresse, hele batteriet', s: 'Skriv en adresse og få ping, TCP, DNS, HTTP, TLS og traceroute i én kørsel — med gentagelse, runder og en stopknap på alle skærme, der kører noget.' } },
    { v: '0.156.1', d: '2026-09-16', area: 'diagnostics',
      en: { t: 'Path MTU, and a duplex mismatch confirmed from late collisions', s: 'Two faults that used to take an afternoon: the MTU black hole is measured, and late collisions are read as the duplex mismatch they are.' },
      da: { t: 'Path MTU — og duplex-mismatch bekræftet ud fra sene kollisioner', s: 'To fejl, der før tog en eftermiddag: MTU-sorthullet bliver målt, og sene kollisioner læses som det duplex-mismatch, de er.' } },
    { v: '0.152.1', d: '2026-09-16', area: 'diagnostics',
      en: { t: 'Diagnose: from a sentence to a confirmed cause', s: 'Describe the fault in your own words and get the likely causes ranked, the tests to run with their values filled in, and a verdict on each cause — confirmed, ruled out or open.' },
      da: { t: 'Diagnose: fra en sætning til en bekræftet årsag', s: 'Beskriv fejlen med dine egne ord og få de sandsynlige årsager rangeret, testene med værdierne udfyldt og en dom over hver årsag — bekræftet, udelukket eller åben.' } },
    { v: '0.150.0', d: '2026-09-15', area: 'assurance',
      en: { t: 'Monitors: mail delivery, and the rest of the silent failures', s: 'A service can be up and still not work. Monitors check the things nobody notices until a customer calls — mail that is accepted but never delivered, first among them.' },
      da: { t: 'Monitorer: mailleverance og de øvrige tavse fejl', s: 'En tjeneste kan være oppe og alligevel ikke virke. Monitorer tjekker det, ingen opdager, før en kunde ringer — mail, der kvitteres, men aldrig leveres, som det første.' } },
    { v: '0.148.0', d: '2026-09-15', area: 'assurance',
      en: { t: 'A traceroute for the mail check, and the phases charted', s: 'Every check type carries its trace, and the phases of a run are plotted against each other on a chart six orders of magnitude can be read on.' },
      da: { t: 'Traceroute til mailtjekket, og faserne i én graf', s: 'Alle checktyper har deres trace med, og faserne i en kørsel tegnes mod hinanden i en graf, hvor seks størrelsesordener kan aflæses.' } },
    { v: '0.146.0', d: '2026-09-15', area: 'platform',
      en: { t: 'The sidebar speaks Danish, and so do the NIS2 reports', s: 'The navigation and the regulator-facing reports go through the translation layer, so the language switch reaches the parts people outside the team read.' },
      da: { t: 'Menuen taler dansk — og det gør NIS2-rapporterne også', s: 'Navigationen og de myndighedsvendte rapporter går gennem oversættelseslaget, så sprogskiftet også når det, folk uden for teamet læser.' } },
    { v: '0.144.3', d: '2026-09-13', area: 'platform',
      en: { t: 'System Logs and User Logs, split apart', s: 'Machine noise and human actions are two different questions. User Logs is the audit trail — who did what — and it is on every plan.' },
      da: { t: 'Systemlog og brugerlog, skilt ad', s: 'Maskinstøj og menneskehandlinger er to forskellige spørgsmål. Brugerloggen er revisionssporet — hvem gjorde hvad — og den er med i alle planer.' } },
    { v: '0.142.1', d: '2026-09-13', area: 'platform',
      en: { t: 'Five guides inside the product', s: 'One next-next walkthrough per section — what to do, in what order, and which values to type in each field. Every number they quote is read from the running system.' },
      da: { t: 'Fem guider inde i produktet', s: 'Én næste-næste-gennemgang pr. sektion — hvad du gør, i hvilken rækkefølge, og hvilke værdier der skal stå i felterne. Alle tal, de nævner, læses fra det kørende system.' } },
    { v: '0.141.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'The AI layer, and the allowlist that decides what it may see', s: 'The assistant may explain an incident — from data an administrator has explicitly allowed it to read, and nothing else.' },
      da: { t: 'AI-laget og den tilladelsesliste, der bestemmer, hvad det må se', s: 'Assistenten må forklare en hændelse — ud fra data, en administrator udtrykkeligt har givet den lov til at læse, og intet andet.' } },
    { v: '0.137.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'One alert per problem, not one per incident', s: 'Twenty failing checks with one cause are one notification. The rollup is what makes alerting survive a real outage.' },
      da: { t: 'Én alarm pr. problem — ikke én pr. hændelse', s: 'Tyve fejlende checks med samme årsag er én besked. Den opsamling er det, der gør alarmering brugbar under et rigtigt udfald.' } },
    { v: '0.132.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'Discovery can sign in', s: 'The parts of an application that live behind a login are the parts that matter. Discovery can now authenticate before it looks around — still read-only.' },
      da: { t: 'Netværksscanning kan logge ind', s: 'De dele af en applikation, der ligger bag et login, er dem, der betyder noget. Discovery kan nu logge ind, før den ser sig omkring — stadig kun læsende.' } },
    { v: '0.131.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'The incident, in full: lifecycle, timeline, impact and recurrence', s: 'An incident opens, changes and closes on its own record, with the observations that built it and whether it has happened before.' },
      da: { t: 'Hændelsen, hele vejen: livscyklus, tidslinje, konsekvens og gentagelse', s: 'En hændelse åbner, ændrer sig og lukker på sin egen sag, med de observationer, der byggede den, og om den er set før.' } },
    { v: '0.130.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'The correlation engine', s: 'Observations that belong to the same fault are gathered into one incident instead of arriving as a list of unrelated failures.' },
      da: { t: 'Korrelationsmotoren', s: 'Observationer, der hører til samme fejl, samles til én hændelse i stedet for at lande som en liste af urelaterede fejl.' } },
    { v: '0.129.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'The observation model and Service Health 2.0', s: 'Everything a run sees becomes an observation with its evidence, and a service score you can take apart into the four things it weighs.' },
      da: { t: 'Observationsmodellen og Service Health 2.0', s: 'Alt, en kørsel ser, bliver til en observation med sin evidens — og en servicescore, du kan skille ad i de fire ting, den vægter.' } },
    { v: '0.128.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'Visual regression', s: 'A page that renders wrong passes every functional check. Screenshots are compared against a baseline, with the difference shown.' },
      da: { t: 'Visuel regression', s: 'En side, der tegnes forkert, består alle funktionelle checks. Skærmbilleder sammenlignes med en baseline, og forskellen vises.' } },
    { v: '0.127.0', d: '2026-09-12', area: 'assurance',
      en: { t: 'Accessibility checks', s: 'Every run can also answer whether the page can be used by somebody who is not using a mouse and a pair of eyes.' },
      da: { t: 'Tilgængelighedstjek', s: 'Hver kørsel kan også svare på, om siden kan bruges af nogen, der ikke bruger en mus og et par øjne.' } },
    { v: '0.126.1', d: '2026-09-12', area: 'assurance',
      en: { t: 'Severity rules', s: 'You decide what "critical" means for your service, rather than accepting somebody else’s idea of it.' },
      da: { t: 'Alvorlighedsregler', s: 'I bestemmer selv, hvad "kritisk" betyder for jeres tjeneste, i stedet for at overtage en andens definition.' } },
    { v: '0.125.10', d: '2026-09-11', area: 'assurance',
      en: { t: 'Performance baselines, evidence, and the service map', s: 'A run that is slower than this service normally is says so, and shows the measurement it compared against.' },
      da: { t: 'Performance-baselines, evidens og servicekortet', s: 'En kørsel, der er langsommere, end tjenesten plejer, siger det — og viser den måling, den sammenlignede med.' } },
    { v: '0.125.9', d: '2026-09-11', area: 'assurance',
      en: { t: 'Self-healing selectors: proposed, never applied', s: 'When a page moves, BlueEyes works out the new selector and asks. A test that silently rewrites itself is a test that stops proving anything.' },
      da: { t: 'Selvhelende selektorer: foreslået, aldrig anvendt', s: 'Når en side flytter sig, finder BlueEyes den nye selektor og spørger. En test, der omskriver sig selv i stilhed, beviser ingenting.' } },
    { v: '0.125.6', d: '2026-09-11', area: 'assurance',
      en: { t: 'User journeys: what the service IS', s: 'A journey is a complete thing a user does — sign in, look up a customer, open the case — and the tests under it are how BlueEyes proves it still works.' },
      da: { t: 'Brugerrejser: det, tjenesten ER', s: 'En rejse er noget helt, en bruger gør — log ind, slå en kunde op, åbn sagen — og testene under den er måden, BlueEyes beviser, at det stadig virker.' } },
    { v: '0.125.1', d: '2026-09-11', area: 'assurance',
      en: { t: 'Record a test by using the application', s: 'A bookmarklet records what you click, and the review screen turns it into steps you can read. No code, and nothing the content policy can refuse.' },
      da: { t: 'Optag en test ved at bruge applikationen', s: 'En bookmarklet optager, hvad du klikker på, og gennemgangsskærmen laver det om til trin, du kan læse. Ingen kode — og intet, indholdspolitikken kan afvise.' } },
    { v: '0.124.0', d: '2026-09-11', area: 'assurance',
      en: { t: 'Run history as a chart', s: 'Which applications gave you the most trouble, which layer failed, and what a reroute cost — read off a trend instead of a list.' },
      da: { t: 'Kørselshistorik som graf', s: 'Hvilke applikationer gav mest besvær, hvilket lag fejlede, og hvad en omlægning kostede — aflæst på en tendens i stedet for en liste.' } },
    { v: '0.123.4', d: '2026-09-10', area: 'assurance',
      en: { t: 'Service Assurance reacts to what it finds', s: 'A failing service reaches the Changes page and the alerting channels you already use, instead of waiting to be looked at.' },
      da: { t: 'Service Assurance reagerer på det, den finder', s: 'En fejlende tjeneste når Ændringer-siden og de alarmkanaler, I allerede bruger, i stedet for at vente på at blive kigget på.' } },
    { v: '0.120.0', d: '2026-09-10', area: 'assurance',
      en: { t: 'BlueEyes Service Assurance', s: 'Synthetic monitoring of your own web services: register the application, let Discovery look around it, accept the tests it suggests, and run them from a real browser on a schedule.' },
      da: { t: 'BlueEyes Service Assurance', s: 'Syntetisk overvågning af jeres egne webtjenester: registrér applikationen, lad Discovery se sig omkring, godkend de foreslåede tests, og kør dem fra en rigtig browser efter en plan.' } },
    { v: '0.118.3', d: '2026-09-06', area: 'platform',
      en: { t: 'One page width, and data inside a frame', s: 'Every page is the same width, every table sits in a card that owns its heading, and expired enrollment codes can be cleared in one go.' },
      da: { t: 'Én sidebredde, og data i en ramme', s: 'Alle sider har samme bredde, alle tabeller sidder i et kort med sin egen overskrift, og udløbne tilmeldingskoder kan ryddes på én gang.' } },
    { v: '0.117.0', d: '2026-09-05', area: 'platform',
      en: { t: 'A pre-build gate on every branch', s: 'Security, UI and validation suites sweep the whole surface — every route, every validator, every menu entry — before a branch can build.' },
      da: { t: 'En pre-build-gate på hver gren', s: 'Sikkerheds-, UI- og valideringssuiter fejer hele fladen igennem — hver rute, hver validator, hvert menupunkt — før en gren kan bygge.' } },
    { v: '0.114.1', d: '2026-08-27', area: 'diagnostics',
      en: { t: 'Troubleshooting stops loading 28 000 alarms to draw four numbers', s: 'The counts are computed where the data lives. The rows behind them are fetched a page at a time, when you ask for them.' },
      da: { t: 'Fejlfinding henter ikke længere 28.000 alarmer for at tegne fire tal', s: 'Tallene regnes ud, hvor data ligger. Rækkerne bag dem hentes en side ad gangen — når du beder om dem.' } },
    { v: '0.113.0', d: '2026-08-27', area: 'diagnostics',
      en: { t: 'Trace the path the traffic actually takes', s: 'Hop by hop, with the change detection that says when the path moved and what it cost.' },
      da: { t: 'Følg den vej, trafikken faktisk tager', s: 'Hop for hop, med den ændringsdetektion, der siger, hvornår vejen flyttede sig, og hvad det kostede.' } },
    { v: '0.112.1', d: '2026-07-31', area: 'insights',
      en: { t: 'The events list says what its columns do not', s: 'Every row carries the sentence that explains it, so a list of events is readable by somebody who did not build it.' },
      da: { t: 'Hændelseslisten siger det, kolonnerne ikke gør', s: 'Hver række har den sætning med, der forklarer den, så listen kan læses af andre end dem, der byggede den.' } },
    { v: '0.111.1', d: '2026-07-31', area: 'insights',
      en: { t: 'One event per condition, and a feed you can scan', s: 'A condition that is true for an hour is one event with a duration, not sixty copies of itself.' },
      da: { t: 'Én hændelse pr. tilstand, og et feed, du kan skimme', s: 'En tilstand, der er sand i en time, er én hændelse med en varighed — ikke tres kopier af sig selv.' } },
    { v: '0.109.1', d: '2026-07-30', area: 'insights',
      en: { t: 'Events, not incidents', s: 'The feed correlates what happened instead of counting what fired, and the vocabulary leaves the code and the database behind.' },
      da: { t: 'Hændelser, ikke incidents', s: 'Feedet korrelerer det, der skete, i stedet for at tælle det, der udløste — og sproget slipper koden og databasen.' } },
    { v: '0.108.1', d: '2026-07-29', area: 'insights',
      en: { t: 'CMDB asset picker, and incidents that say where they are', s: 'Search by asset ID, name or location, and every incident names the agent and the site it happened at.' },
      da: { t: 'CMDB-aktivvælger, og hændelser der siger hvor de er', s: 'Søg på aktiv-id, navn eller lokation — og hver hændelse nævner den agent og den lokation, den skete på.' } },
    { v: '0.99.0', d: '2026-07-27', area: 'diagnostics',
      en: { t: 'The consolidated Troubleshooting dashboard', s: 'One screen for an outage: what is failing, what it affects, when it started — correlated causes, topology coloured by state, baseline deviations and a change timeline.' },
      da: { t: 'Den samlede fejlfindings-skærm', s: 'Én skærm til et udfald: hvad fejler, hvad det rammer, hvornår det startede — korrelerede årsager, topologi farvet efter tilstand, baseline-afvigelser og en ændringstidslinje.' } },
    { v: '0.98.2', d: '2026-07-27', area: 'platform',
      en: { t: 'BlueEyes Network Resilience System', s: 'The product gets the name it had grown into.' },
      da: { t: 'BlueEyes Network Resilience System', s: 'Produktet får det navn, det var vokset ind i.' } },
    { v: '0.96.0', d: '2026-07-26', area: 'monitoring',
      en: { t: 'Traffic map with coloured flow arrows', s: 'Where the traffic goes, drawn on the map, with a drill-down into the site behind each arrow.' },
      da: { t: 'Trafikkort med farvede flowpile', s: 'Hvor trafikken går, tegnet på kortet, med et drill-down til lokationen bag hver pil.' } },
    { v: '0.94.1', d: '2026-07-25', area: 'insights',
      en: { t: 'Analysis overview, filterable and sortable', s: 'The findings the detector produced, in tables you can cut down to the ones you care about.' },
      da: { t: 'Analyseoverblik — med filtrering og sortering', s: 'De fund, detektoren har lavet, i tabeller du kan skære ned til dem, der betyder noget for dig.' } },
    { v: '0.90.0', d: '2026-07-24', area: 'insights',
      en: { t: 'Per-flow-pair volume baselines', s: 'A pair that normally moves 1 GB at 09:00 on a Monday and today moved 4 GB is a finding, computed from its own history.' },
      da: { t: 'Volumen-baselines pr. flowpar', s: 'Et par, der plejer at flytte 1 GB kl. 09:00 om mandagen og i dag flyttede 4 GB, er et fund — regnet ud på parrets egen historik.' } },
    { v: '0.89.0', d: '2026-07-24', area: 'diagnostics',
      en: { t: 'Topology change detection', s: 'LLDP neighbour changes are recorded with the evidence, so "what changed before this broke" has an answer.' },
      da: { t: 'Detektion af topologiændringer', s: 'LLDP-naboændringer gemmes med evidensen, så "hvad ændrede sig, før det her gik i stykker" har et svar.' } },
    { v: '0.88.0', d: '2026-07-24', area: 'diagnostics',
      en: { t: 'Blast radius', s: 'From a failing node: which hosts are cut off, and which services depend on them.' },
      da: { t: 'Konsekvensradius', s: 'Ud fra en fejlende node: hvilke hosts er afskåret, og hvilke tjenester afhænger af dem.' } },
    { v: '0.87.1', d: '2026-07-24', area: 'diagnostics',
      en: { t: 'Service dependency graph', s: 'Who talks to whom, built from the flows the agents already report.' },
      da: { t: 'Serviceafhængighedsgraf', s: 'Hvem taler med hvem, bygget på de flows, agenterne allerede rapporterer.' } },
    { v: '0.84.0', d: '2026-07-21', area: 'insights',
      en: { t: 'An evidence snapshot when a situation opens', s: 'Read-only, automatic, taken at the moment it mattered — so the state that produced the finding is still there tomorrow.' },
      da: { t: 'Et evidens-øjebliksbillede, når en situation åbner', s: 'Kun læsende, automatisk, taget i det øjeblik det gjaldt — så den tilstand, der skabte fundet, stadig findes i morgen.' } },
    { v: '0.83.0', d: '2026-07-21', area: 'insights',
      en: { t: 'Cluster alerting, the ITSM bridge and the NIS2 draft', s: 'A cross-agent situation raises one alert, opens one ticket, and drafts the report the regulator asks for.' },
      da: { t: 'Klyngealarmering, ITSM-broen og NIS2-udkastet', s: 'En situation på tværs af agenter giver én alarm, én sag — og et udkast til den rapport, myndigheden beder om.' } },
    { v: '0.81.0', d: '2026-07-16', area: 'insights',
      en: { t: 'Recommended actions, and a verification loop', s: 'What to do about it, and a check afterwards that says whether it worked.' },
      da: { t: 'Anbefalede handlinger og en verifikationssløjfe', s: 'Hvad du gør ved det — og et tjek bagefter, der siger, om det virkede.' } },
    { v: '0.80.0', d: '2026-07-16', area: 'insights',
      en: { t: 'The Situation view: timeline, what changed, evidence', s: 'One page per situation, holding everything that was true around it.' },
      da: { t: 'Situationsvisningen: tidslinje, hvad ændrede sig, evidens', s: 'Én side pr. situation med alt det, der var sandt omkring den.' } },
    { v: '0.79.1', d: '2026-07-16', area: 'insights',
      en: { t: 'Cross-agent incident clusters', s: 'Twenty devices reporting the same uplink failure are one situation with a lifecycle, not twenty alarms.' },
      da: { t: 'Hændelsesklynger på tværs af agenter', s: 'Tyve enheder, der melder samme uplink-fejl, er én situation med en livscyklus — ikke tyve alarmer.' } },
    { v: '0.76.5', d: '2026-07-15', area: 'insights',
      en: { t: '"What changed before this finding"', s: 'The per-target timeline puts the config pushes, port flaps and new routes from before the fault next to the fault itself.' },
      da: { t: '"Hvad ændrede sig før dette fund"', s: 'Tidslinjen pr. mål stiller de konfigurationsændringer, portflap og nye ruter, der kom før fejlen, op ved siden af fejlen selv.' } },
    { v: '0.74.0', d: '2026-07-14', area: 'platform',
      en: { t: 'Bring your own ITSM, CMDB and AI', s: 'Preset catalogues for the common systems, and a manual option for the one that is not on the list.' },
      da: { t: 'Tag jeres eget ITSM, CMDB og AI med', s: 'Færdige kataloger til de gængse systemer — og en manuel mulighed til det, der ikke står på listen.' } },
    { v: '0.73.1', d: '2026-07-14', area: 'platform',
      en: { t: 'The built-in handbook', s: 'Troubleshooting how-tos for everyone and setup guides for administrators, with what a working connection and a failure each look like.' },
      da: { t: 'Den indbyggede håndbog', s: 'Fejlfindings-vejledninger til alle og opsætningsguides til administratorer — med hvordan en virkende forbindelse og en fejl hver især ser ud.' } },
    { v: '0.71.1', d: '2026-07-14', area: 'insights',
      en: { t: 'Remediation playbooks', s: 'The knowledge about a recurring fault written down as a playbook the product can recommend.' },
      da: { t: 'Udbedrings-playbooks', s: 'Viden om en tilbagevendende fejl skrevet ned som en playbook, produktet kan anbefale.' } },
    { v: '0.66.0', d: '2026-07-12', area: 'fleet',
      en: { t: 'A fleet-wide default traffic source', s: 'New agents inherit the source the fleet already uses instead of being configured one at a time.' },
      da: { t: 'En standard trafikkilde for hele flåden', s: 'Nye agenter arver den kilde, flåden allerede bruger, i stedet for at blive sat op én ad gangen.' } },
    { v: '0.62.0', d: '2026-07-10', area: 'monitoring',
      en: { t: 'Topology on a map: public peers and routes', s: 'The same graph, laid over geography, for the part of the path that leaves your own network.' },
      da: { t: 'Topologi på kort: offentlige peers og ruter', s: 'Den samme graf lagt ned over geografien — for den del af vejen, der forlader jeres eget netværk.' } },
    { v: '0.48.1', d: '2026-07-10', area: 'platform',
      en: { t: 'Choose your AI provider (or none)', s: 'Mistral, another provider, or your own endpoint — and the product works with the assistant switched off.' },
      da: { t: 'Vælg jeres AI-udbyder (eller ingen)', s: 'Mistral, en anden udbyder eller jeres eget endpoint — og produktet virker med assistenten slået fra.' } },
    { v: '0.44.1', d: '2026-07-05', area: 'fleet',
      en: { t: 'Agent connection diagnosis and forced reconnect', s: 'Why an agent is not reporting, answered from the server, with a reconnect you can push from the same screen.' },
      da: { t: 'Diagnose af agentforbindelsen og tvungen genforbindelse', s: 'Hvorfor en agent ikke rapporterer, besvaret fra serveren — med en genforbindelse, du kan sende fra samme skærm.' } },
    { v: '0.43.0', d: '2026-07-04', area: 'platform',
      en: { t: 'TimescaleDB for the time series', s: 'An optional dedicated telemetry store, with the storage counter reporting MySQL and TimescaleDB separately.' },
      da: { t: 'TimescaleDB til tidsserierne', s: 'Et valgfrit dedikeret telemetrilager, hvor lagertælleren viser MySQL og TimescaleDB hver for sig.' } },
    { v: '0.42.0', d: '2026-07-04', area: 'diagnostics',
      en: { t: 'Transaction tests: matrix, heatmap, trend, diagnosis', s: 'Multi-step tests across the fleet, with baseline deviation and a cross-check that says which side of the transaction failed.' },
      da: { t: 'Transaktionstests: matrix, heatmap, tendens, diagnose', s: 'Flertrinstests på tværs af flåden, med baseline-afvigelse og et krydstjek, der siger, hvilken side af transaktionen der fejlede.' } },
    { v: '0.41.0', d: '2026-07-04', area: 'platform',
      en: { t: 'The admin Logs view', s: 'The operational stream and the errors the dashboard itself hit, in one place.' },
      da: { t: 'Log-visningen for administratorer', s: 'Driftsstrømmen og de fejl, dashboardet selv løb ind i, samlet ét sted.' } },
    { v: '0.38.0', d: '2026-07-01', area: 'diagnostics',
      en: { t: 'A force-directed topology diagram', s: 'The dependency graph laid out so it can be read, not just queried.' },
      da: { t: 'Et kraftbaseret topologidiagram', s: 'Afhængighedsgrafen tegnet, så den kan læses — ikke kun forespørges.' } },
    { v: '0.37.0', d: '2026-06-20', area: 'monitoring',
      en: { t: 'One flow view, and a topology filtered per site', s: 'The flow inspector and the flow list stop being two screens that answer the same question.' },
      da: { t: 'Én flowvisning og en topologi filtreret pr. lokation', s: 'Flow-inspektøren og flowlisten holder op med at være to skærme til samme spørgsmål.' } },
    { v: '0.36.0', d: '2026-06-17', area: 'insights',
      en: { t: 'Two outputs from a troubleshooting session', s: 'Advice for the engineer, and a NIS2 draft for the report — from the same evidence.' },
      da: { t: 'To resultater fra en fejlfindingssession', s: 'Rådgivning til teknikeren og et NIS2-udkast til rapporten — ud fra den samme evidens.' } },
    { v: '0.35.0', d: '2026-06-17', area: 'monitoring',
      en: { t: 'Bidirectional flow inspector, and geocoding through the server', s: 'Both directions of a conversation in one row, and address lookups proxied by the server so no browser talks to a third party.' },
      da: { t: 'Tovejs flow-inspektør og geokodning via serveren', s: 'Begge retninger af en samtale i samme række, og adresseopslag gennem serveren, så ingen browser taler med tredjepart.' } },
    { v: '0.33.0', d: '2026-06-16', area: 'fleet',
      en: { t: 'Self-contained agent binaries', s: 'The install footprint drops by about 80%, with Docker as an automatic fallback when no binary fits.' },
      da: { t: 'Selvstændige agent-binære filer', s: 'Installationens fodaftryk falder omkring 80%, med Docker som automatisk reserve, når ingen binær passer.' } },
    { v: '0.26.0', d: '2026-06-14', area: 'platform',
      en: { t: 'The Test area: outbound connectivity and security screening', s: 'An administrator can prove, from the server, that every outbound integration the product needs actually works.' },
      da: { t: 'Testområdet: udgående forbindelser og sikkerhedsscreening', s: 'En administrator kan bevise fra serveren, at hver udgående integration, produktet skal bruge, rent faktisk virker.' } },
    { v: '0.25.0', d: '2026-06-12', area: 'diagnostics',
      en: { t: 'AS-path view and change detection', s: 'Which networks the traffic crosses, and a record of when that changed.' },
      da: { t: 'AS-sti-visning og ændringsdetektion', s: 'Hvilke netværk trafikken krydser — og en registrering af, hvornår det ændrede sig.' } },
    { v: '0.15.0', d: '2026-06-10', area: 'diagnostics',
      en: { t: 'Multi-step transaction tests, page load and cURL', s: 'Three more ways to ask whether the thing on the other end still answers.' },
      da: { t: 'Flertrins-transaktionstests, sideindlæsning og cURL', s: 'Tre nye måder at spørge, om det i den anden ende stadig svarer.' } },
    { v: '0.12.0', d: '2026-06-10', area: 'platform',
      en: { t: 'A server-wide audit trail', s: 'Every action that changes something is recorded, and an administrator can read the whole chain under Reporting.' },
      da: { t: 'Et revisionsspor for hele serveren', s: 'Hver handling, der ændrer noget, registreres, og en administrator kan læse hele kæden under Rapportering.' } },
    { v: '0.4.0', d: '2026-06-09', area: 'diagnostics',
      en: { t: 'Traceroute path visualisation', s: 'The path drawn hop by hop, and plotted on the Destinations map.' },
      da: { t: 'Visualisering af traceroute-sti', s: 'Vejen tegnet hop for hop og lagt ned på Destinationer-kortet.' } },
    { v: '0.3.0', d: '2026-06-08', area: 'insights',
      en: { t: 'The NIS2 Reporting Center', s: 'The reports the directive asks for, built from the incidents the product already holds.' },
      da: { t: 'NIS2-rapporteringscentret', s: 'De rapporter, direktivet kræver, bygget på de hændelser, produktet allerede har.' } },
    { v: '0.2.2', d: '2026-06-07', area: 'platform',
      en: { t: 'ITSM/IPAM integrations and LDAP/AD login', s: 'The product joins the systems you already run — including the directory people sign in with.' },
      da: { t: 'ITSM/IPAM-integrationer og LDAP/AD-login', s: 'Produktet kobler sig på de systemer, I allerede kører — inklusive det katalog, folk logger ind med.' } },
    { v: '0.2.2', d: '2026-06-06', area: 'fleet',
      en: { t: 'Signed agent releases, and an audit trail per agent', s: 'An update an agent accepts is one the server signed, and every action taken on an agent is recorded.' },
      da: { t: 'Signerede agent-udgivelser og revisionsspor pr. agent', s: 'En opdatering, en agent accepterer, er en, serveren har signeret — og hver handling på en agent registreres.' } },
    { v: '0.2.1', d: '2026-06-05', area: 'fleet',
      en: { t: 'One-click ping, update and speed test', s: 'The things you used to SSH for, done from the agent list — with the Updates panel that says which agents are behind.' },
      da: { t: 'Ping, opdatering og hastighedstest med ét klik', s: 'Det, man før brugte SSH til, gjort fra agentlisten — med det opdateringspanel, der siger, hvilke agenter der er bagud.' } },
    { v: '0.1.0', d: '2026-06-03', area: 'fleet',
      en: { t: 'Frictionless enrollment', s: 'A one-time code and a single install line. An agent is on the fleet in under a minute.' },
      da: { t: 'Tilmelding uden besvær', s: 'En engangskode og én installationslinje. En agent er på flåden på under et minut.' } },
    { v: '0.1.0', d: '2026-06-02', area: 'diagnostics',
      en: { t: 'Active probes, interface health and the conversation explorer', s: 'Ping, TCP, DNS and traceroute from an agent; utilisation, errors and discards per interface; and the flows behind them, searchable.' },
      da: { t: 'Aktive probes, interface-sundhed og samtaleudforskeren', s: 'Ping, TCP, DNS og traceroute fra en agent; udnyttelse, fejl og discards pr. interface — og de flows, der ligger bag, søgbare.' } },
    { v: '0.1.0', d: '2026-06-01', area: 'insights',
      en: { t: 'The analysis engine', s: 'Baselines from median and MAD, a robust z-score detector, a correlator that hints at the root cause — all local, all explainable, with alerting, retention and geo enrichment alongside it.' },
      da: { t: 'Analysemotoren', s: 'Baselines fra median og MAD, en robust z-score-detektor og en korrelator, der peger på rodårsagen — alt lokalt, alt forklarligt, med alarmering, opbevaring og geo-berigelse ved siden af.' } },
    { v: '0.1.0', d: '2026-05-31', area: 'monitoring',
      en: { t: 'Live traffic, NetFlow and sFlow', s: 'Per-location traffic as it happens, a history explorer you can brush into, and the sites on a map.' },
      da: { t: 'Live trafik, NetFlow og sFlow', s: 'Trafik pr. lokation, mens den sker, en historikudforsker du kan markere i — og lokationerne på et kort.' } },
    { v: '0.1.0', d: '2026-05-29', area: 'platform',
      en: { t: 'Users, roles and agents that enroll', s: 'JWT login with admin/operator/viewer, one-time enrollment codes, opaque agent tokens and the WebSocket channel the agents report on.' },
      da: { t: 'Brugere, roller og agenter, der tilmelder sig', s: 'JWT-login med admin/operatør/læser, engangskoder til tilmelding, uigennemsigtige agent-tokens og den WebSocket-kanal, agenterne rapporterer på.' } },
    { v: '0.1.0', d: '2026-05-28', area: 'platform',
      en: { t: 'First commit', s: 'Locations, health, and a server to hang the rest on.' },
      da: { t: 'Første commit', s: 'Lokationer, sundhedstjek — og en server at hænge resten op på.' } },
  ];

  // Month bucket for grouping: "2026-09-17" → "2026-09".
  function monthOf(entry) { return String(entry.d).slice(0, 7); }

  // "September 2026" / "september 2026" — the browser knows both, so a month
  // heading needs no catalogue entry. A locale the browser does not know falls
  // back to the raw bucket rather than throwing the page away.
  function monthLabel(bucket, locale) {
    var parts = String(bucket).split('-');
    var date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
    try {
      return date.toLocaleDateString(locale || 'en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch (err) { return bucket; }
  }

  // Newest first, grouped by month: [{ bucket, items }, …].
  function byMonth(entries) {
    var order = [];
    var groups = {};
    entries.forEach(function (e) {
      var b = monthOf(e);
      if (!groups[b]) { groups[b] = []; order.push(b); }
      groups[b].push(e);
    });
    return order.map(function (b) { return { bucket: b, items: groups[b] }; });
  }

  var About = { AREAS: AREAS, AREA_KEYS: AREA_KEYS, RELEASES: RELEASES, byMonth: byMonth, monthLabel: monthLabel };
  if (root) root.About = About;
  if (typeof module !== 'undefined' && module.exports) module.exports = About;
})(typeof window !== 'undefined' ? window : null);
