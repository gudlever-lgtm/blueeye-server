'use strict';

// Server-side translation for the NIS2 report documents.
//
// Why this is not public/i18n.js: that module is the browser's catalogue and
// keeps ONE active locale in module state. A server renders reports for several
// users at once, so a shared "current locale" would let one request's language
// leak into another's document. Here the locale is a parameter — createT(locale)
// hands back a bound lookup and nothing is stored between calls.
//
// Scope: the print-ready NIS2 documents (executive report, the register PDFs,
// the Report Generator's headings and labels). The dashboard's own screens stay
// with public/i18n.js.
//
// The line on record VALUES:
//   * The executive + register reports translate enum values too (open,
//     Overdue, Critical, the ten NIS2 areas). Those documents are read by
//     management and, for an Article 23 notification, by an authority — a
//     Danish report that says "mitigating" is not a Danish report.
//   * The Report Generator translates headings, column labels and the
//     generated yes/no only. It is an extraction tool: the user picks columns
//     and expects the register's own values back, not a rewritten copy.

const LOCALES = Object.freeze(['en', 'da']);
const DEFAULT_LOCALE = 'en';

const STRINGS = {
  en: {
    // --- document chrome
    // ---- Executive network report (src/analysis/networkReport.js) ----
    'net.title': 'Network status — executive summary',
    'net.sec.conclusion': 'Conclusion',
    'net.sec.where': 'Where to focus',
    'net.sec.what': 'What is firing most',
    'net.col.measure': 'Measure',
    'net.col.value': 'Value',
    'net.col.place': 'Place',
    'net.col.location': 'Site',
    'net.col.crit': 'Critical',
    'net.col.warn': 'Warning',
    'net.col.issues': 'Issues to fix',
    'net.col.last': 'Last seen',
    'net.col.issue': 'Issue',
    'net.col.count': 'Count',
    'net.col.share': 'Share',
    'net.m.period': 'Period',
    'net.m.periodDays': 'Last {days} days',
    'net.m.findings': 'Findings',
    'net.m.unack': 'Not yet accepted',
    'net.m.crit': 'Critical',
    'net.m.warn': 'Warning',
    'net.m.places': 'Places with findings',
    'net.where.intro': 'The {n} places below account for most of what is wrong. {rest} further places had findings that did not meet the threshold for listing.',
    'net.where.introAll': 'All {n} places with findings are listed.',
    'net.where.none': 'Nothing to report',
    'net.what.intro': 'The checks that produced the most findings in the period. A high count is not automatically a high priority — read it with the places above.',
    'net.issue.unknown': 'an unidentified issue',
    'net.concl.clean': 'No findings were recorded in this period.',
    'net.concl.spread': '{n} findings were recorded across {places} places, none of which individually met the threshold for listing. This is a broad, thin spread rather than a concentrated fault.',
    'net.concl.focus': 'Start at {place}, where {issue} is the main issue. There are {crit} critical findings in total, concentrated in {n} places.',
    'net.trend.better': 'The rate is falling — roughly {pct}% fewer in the second half of the period than the first.',
    'net.trend.worse': 'The rate is rising — roughly {pct}% more in the second half of the period than the first.',
    'net.trend.flat': 'The rate is broadly unchanged across the period.',
    'net.trend.unknown': 'The period is too short to say whether this is getting better or worse.',
    'doc.org': 'Organisation',
    'doc.generated': 'Generated {when}',
    'doc.none': 'None.',
    'doc.yes': 'yes',
    'doc.no': 'no',
    'doc.dash': '—',

    // --- report titles (also the defaults POST /reports stores)
    'title.executive': 'NIS2 Executive Report',
    'title.readiness': 'NIS2 Readiness Report',
    'title.risk': 'NIS2 Risk Register Report',
    'title.control': 'NIS2 Control Evidence Report',
    'title.incident': 'NIS2 Incident Report',
    'title.custom': 'Custom Report',

    // --- executive report sections
    'exec.s1': '1. Overall status',
    'exec.s2': '2. Risk overview',
    'exec.s3': '3. Significant incidents',
    'exec.s4': '4. Missing controls',
    'exec.s5': '5. Development since last report',
    'exec.s6': '6. Recommended management decisions',
    'exec.s7': '7. Conclusion',
    'exec.kpi.readiness': 'Readiness',
    'exec.kpi.criticalRisks': 'Open critical risks',
    'exec.kpi.findings': 'High/medium findings',
    'exec.kpi.noEvidence': 'Controls w/o evidence',
    'exec.noBaseline': 'No previous report to compare against — this is the baseline.',
    'exec.noActions': 'No outstanding actions.',

    // --- management conclusion
    'concl.posture.good': 'broadly in good shape',
    'concl.posture.gaps': 'progressing but with gaps that need management attention',
    'concl.posture.partial': 'only partially prepared, with material gaps',
    'concl.posture.early': 'at an early stage of NIS2 readiness, with significant gaps',
    'concl.headline': 'Overall NIS2 readiness stands at {score}%, meaning the organisation is {posture}.',
    'concl.criticalRisks': '{n} critical risk(s) remain open and warrant a documented management decision.',
    'concl.noEvidence': '{n} control(s) lack current evidence and should be prioritised.',
    'concl.incidents': '{n} security incident(s) were recorded in the last 30 days; any with a notification obligation must be reviewed promptly.',
    'concl.clean': 'No critical risks are open and all controls carry evidence — focus can shift to sustaining and auditing the programme.',

    // --- recommended actions (dashboard.topActions, rendered into the report)
    'action.risk.planCritical': 'Define a mitigation plan for critical risk "{title}"',
    'action.risk.progressCritical': 'Progress mitigation of critical risk "{title}"',
    'action.risk.planHigh': 'Define a mitigation plan for high risk "{title}"',
    'action.control.overdue': 'Perform the overdue control "{name}" ({area})',
    'action.control.missing': 'Establish and evidence the control "{name}" ({area})',
    'action.control.noEvidence': 'Attach evidence to the control "{name}" ({area})',
    'action.incident.notify': 'Assess NIS2 notification obligation for incident {ref} "{title}"',
    'action.category.empty': 'Define controls for {category} — no controls recorded yet',

    // --- readiness document
    'readiness.heading': 'Overall readiness: {score}%',
    'readiness.intro': "Readiness is the mean of the ten NIS2 category scores, each derived from how complete its controls' evidence is (OK = 100, Partial = 50, Missing/Overdue = 0) — a self-assessment aid, not a certificate. Open critical risks: {criticalRisks} · High/medium findings: {findings} · Incidents (30d): {incidents} · Controls without evidence: {noEvidence}",
    'readiness.actions': 'Top recommended actions',

    // --- register documents
    'risk.heading': 'Risk register ({n})',
    'risk.intro': 'Risks to the systems and services in scope, each scored likelihood × impact (1–25, columns L and I) and banded Low–Critical. Maintaining this register — with an owner, a treatment status and, where a risk is tolerated, explicit management acceptance — is how the risk-management duty under NIS2 (Article 21) is evidenced.',
    'control.heading': 'Controls ({n})',
    'control.intro': 'The technical and organisational security measures in operation (e.g. backups, patching, access reviews, logging), each tied to a NIS2 area with an owner and a recurring cadence. NIS2 (Article 21) requires these measures to be implemented and kept effective; the "Evidence" column shows whether a reference proving the control was performed is on file — controls without evidence, or marked Missing/Overdue, are the gaps to close.',
    'incident.heading': 'Incidents ({n})',
    'incident.intro': 'Security incidents recorded for NIS2 — what happened, when it was detected and resolved, and the impact. "Notify" marks incidents judged significant, which trigger the reporting duty to the national CSIRT/authority under NIS2 (Article 23): an early warning within 24 hours, a full incident notification within 72 hours, and a final report within one month. "NIS2" flags incidents in scope of the directive.',
    'art23.heading': 'Article 23 reporting ({n})',
    'art23.intro': 'What NIS2 Article 23 asks the notifications to contain, and when each one went out. "Suspected malicious" and "Cross-border impact" are the two statements the early warning must make (23(4)(a)). The authority reference is the case number the CSIRT or competent authority gave the incident. A submission marked "late" was sent after its deadline (24 hours, 72 hours, one month after the notification). The deadline status is the worst stage not yet submitted; "not required" means the incident carries no reporting duty.',
    'art23.late': '{when} (late)',
    'art23.crossBorderDetails': 'yes — {details}',
    'art23.eventCase': 'case #{id}',
    'art23.notRequired': 'not required',
    'art23.noDetection': 'no detection time',
    'incidents.heading': 'Security incidents ({n})',
    'audit.heading': 'Audit trail ({n})',
    'summary.heading': 'Readiness summary',
    'categories.heading': 'Category status',

    // --- column headers
    'col.metric': 'Metric',
    'col.value': 'Value',
    'col.change': 'Change',
    'col.category': 'Category',
    'col.controls': 'Controls',
    'col.score': 'Score',
    'col.status': 'Status',
    'col.risk': 'Risk',
    'col.band': 'Band',
    'col.owner': 'Owner',
    'col.ref': 'Ref',
    'col.title': 'Title',
    'col.severity': 'Severity',
    'col.nis2': 'NIS2',
    'col.notify': 'Notify',
    'col.control': 'Control',
    'col.area': 'Area',
    'col.evidence': 'Evidence',
    'col.priority': 'Priority',
    'col.action': 'Action',
    'col.id': 'ID',
    'col.asset': 'Asset',
    'col.likelihood': 'Likelihood',
    'col.impact': 'Impact',
    'col.l': 'L',
    'col.i': 'I',
    'col.mitigation': 'Mitigation',
    'col.due': 'Due',
    'col.mgmtAccepted': 'Mgmt accepted',
    'col.created': 'Created',
    'col.updated': 'Updated',
    'col.description': 'Description',
    'col.frequency': 'Frequency',
    'col.lastPerformed': 'Last performed',
    'col.nextDue': 'Next due',
    'col.hasEvidence': 'Has evidence',
    'col.comment': 'Comment',
    'col.detected': 'Detected',
    'col.started': 'Started',
    'col.resolved': 'Resolved',
    'col.affectedSystems': 'Affected systems',
    'col.businessImpact': 'Business impact',
    'col.rootCause': 'Root cause',
    'col.actionsTaken': 'Actions taken',
    'col.nis2Relevant': 'NIS2 relevant',
    'col.lessons': 'Lessons learned',
    'col.suspectedMalicious': 'Suspected malicious',
    'col.crossBorder': 'Cross-border impact',
    'col.authorityRef': 'Authority reference',
    'col.earlyWarningSubmitted': 'Early warning sent',
    'col.notificationSubmitted': 'Notification sent',
    'col.finalReportSubmitted': 'Final report sent',
    'col.deadlineStatus': 'Deadline status',
    'col.eventCase': 'Event case',
    'col.when': 'When',
    'col.user': 'User',
    'col.entity': 'Entity',
    'col.entityId': 'Entity ID',

    // --- readiness summary metric names
    'metric.readiness': 'Readiness score',
    'metric.criticalRisks': 'Open critical risks',
    'metric.findings': 'Open high/medium findings',
    'metric.incidents30': 'Incidents (last 30 days)',
    'metric.incidents30short': 'Incidents (30d)',
    'metric.noEvidence': 'Controls without evidence',
    'metric.totalRisks': 'Total risks',
    'metric.totalControls': 'Total controls',
    'metric.totalIncidents': 'Total incidents',

    // --- Report Generator source catalogue
    'src.summary.label': 'Readiness summary',
    'src.summary.description': 'The board-level snapshot: overall readiness %, open critical risks, recent incidents and how many controls still lack evidence.',
    'src.categories.label': 'Category status',
    'src.categories.description': 'Readiness broken down across the ten NIS2 risk-management areas (Governance, Access Control, Incident Response, …) — where you are covered and where the gaps are.',
    'src.risks.label': 'Risk register',
    'src.risks.description': 'Your inventory of cyber risks, each scored likelihood × impact with a band, owner and treatment status — the evidence of risk management required by NIS2 (Article 21).',
    'src.controls.label': 'Controls',
    'src.controls.description': 'The technical and organisational security measures you operate — each tied to a NIS2 area with an owner and a cadence — and whether an evidence reference proving it was performed is on file.',
    'src.incidents.label': 'Security incidents',
    'src.incidents.description': 'Recorded security incidents with severity, timeline and impact. The "Notify" flag marks significant incidents that carry a reporting duty to the authority/CSIRT under NIS2 (Article 23) — the basis for that report.',
    'src.audit.label': 'Audit trail',
    'src.audit.description': 'Who changed which risk, control, incident or report, and when — the change history that shows the programme is actively maintained (admin only).',

    // --- filters
    'filter.any': 'Any',
    'filter.yes': 'Yes',
    'filter.no': 'No',
    'filter.minScore': 'Min score',
    'filter.evidencePresent': 'Has evidence',
    'filter.evidenceMissing': 'Missing evidence',
    'filter.notificationRequired': 'Notification required',
    'filter.detectedFrom': 'Detected from',
    'filter.detectedTo': 'Detected to',

    // --- enum values (executive + register documents only)
    'cat.Governance': 'Governance',
    'cat.Risk Management': 'Risk Management',
    'cat.Incident Response': 'Incident Response',
    'cat.Backup/Recovery': 'Backup/Recovery',
    'cat.Access Control': 'Access Control',
    'cat.Supplier Management': 'Supplier Management',
    'cat.Network Security': 'Network Security',
    'cat.Logging/Monitoring': 'Logging/Monitoring',
    'cat.Vulnerability Management': 'Vulnerability Management',
    'cat.Documentation': 'Documentation',
    'band.Low': 'Low',
    'band.Medium': 'Medium',
    'band.High': 'High',
    'band.Critical': 'Critical',
    'riskStatus.open': 'open',
    'riskStatus.mitigating': 'mitigating',
    'riskStatus.accepted': 'accepted',
    'riskStatus.closed': 'closed',
    'controlStatus.OK': 'OK',
    'controlStatus.Partial': 'Partial',
    'controlStatus.Missing': 'Missing',
    'controlStatus.Overdue': 'Overdue',
    'frequency.daily': 'daily',
    'frequency.weekly': 'weekly',
    'frequency.monthly': 'monthly',
    'frequency.quarterly': 'quarterly',
    'frequency.annually': 'annually',
    'frequency.ad-hoc': 'ad-hoc',
    'severity.low': 'low',
    'severity.medium': 'medium',
    'severity.high': 'high',
    'severity.critical': 'critical',
    'incidentStatus.open': 'open',
    'incidentStatus.investigating': 'investigating',
    'incidentStatus.contained': 'contained',
    'incidentStatus.resolved': 'resolved',
    'incidentStatus.closed': 'closed',
    'deadlineStatus.overdue': 'overdue',
    'deadlineStatus.due-soon': 'due soon',
    'deadlineStatus.upcoming': 'upcoming',
    'deadlineStatus.submitted': 'all submitted',
    'deadlineStatus.none': 'none',
    'catStatus.good': 'good',
    'catStatus.partial': 'partial',
    'catStatus.weak': 'weak',
    'catStatus.no-data': 'no-data',
    'entityType.risk': 'risk',
    'entityType.control': 'control',
    'entityType.incident': 'incident',
    'entityType.report': 'report',
    'entityType.evidence': 'evidence',
    'priority.critical': 'critical',
    'priority.high': 'high',
    'priority.medium': 'medium',
  },

  da: {
    // ---- Executive network report (src/analysis/networkReport.js) ----
    'net.title': 'Netværksstatus — ledelsesresumé',
    'net.sec.conclusion': 'Konklusion',
    'net.sec.where': 'Hvor der skal sættes ind',
    'net.sec.what': 'Hvad der udløser mest',
    'net.col.measure': 'Mål',
    'net.col.value': 'Værdi',
    'net.col.place': 'Sted',
    'net.col.location': 'Lokation',
    'net.col.crit': 'Kritisk',
    'net.col.warn': 'Advarsel',
    'net.col.issues': 'Problemer der skal løses',
    'net.col.last': 'Sidst set',
    'net.col.issue': 'Problem',
    'net.col.count': 'Antal',
    'net.col.share': 'Andel',
    'net.m.period': 'Periode',
    'net.m.periodDays': 'Seneste {days} dage',
    'net.m.findings': 'Fund',
    'net.m.unack': 'Endnu ikke accepteret',
    'net.m.crit': 'Kritisk',
    'net.m.warn': 'Advarsel',
    'net.m.places': 'Steder med fund',
    'net.where.intro': 'De {n} steder nedenfor står for størstedelen af det, der er galt. Yderligere {rest} steder havde fund, som ikke nåede tærsklen for at blive listet.',
    'net.where.introAll': 'Alle {n} steder med fund er listet.',
    'net.where.none': 'Intet at rapportere',
    'net.what.intro': 'De tjek, der gav flest fund i perioden. Et højt antal er ikke automatisk høj prioritet — læs det sammen med stederne ovenfor.',
    'net.issue.unknown': 'et uidentificeret problem',
    'net.concl.clean': 'Der blev ikke registreret fund i denne periode.',
    'net.concl.spread': 'Der blev registreret {n} fund fordelt på {places} steder, hvoraf ingen enkeltvis nåede tærsklen for at blive listet. Det er en bred, tynd spredning frem for én koncentreret fejl.',
    'net.concl.focus': 'Start på {place}, hvor {issue} er hovedproblemet. Der er {crit} kritiske fund i alt, koncentreret på {n} steder.',
    'net.trend.better': 'Raten falder — ca. {pct}% færre i anden halvdel af perioden end i første.',
    'net.trend.worse': 'Raten stiger — ca. {pct}% flere i anden halvdel af perioden end i første.',
    'net.trend.flat': 'Raten er stort set uændret gennem perioden.',
    'net.trend.unknown': 'Perioden er for kort til at sige, om det bliver bedre eller værre.',
    'doc.org': 'Organisation',
    'doc.generated': 'Genereret {when}',
    'doc.none': 'Ingen.',
    'doc.yes': 'ja',
    'doc.no': 'nej',
    'doc.dash': '—',

    'title.executive': 'NIS2-ledelsesrapport',
    'title.readiness': 'NIS2-modenhedsrapport',
    'title.risk': 'NIS2-risikoregister',
    'title.control': 'NIS2-kontroldokumentation',
    'title.incident': 'NIS2-hændelsesrapport',
    'title.custom': 'Tilpasset rapport',

    'exec.s1': '1. Samlet status',
    'exec.s2': '2. Risikooverblik',
    'exec.s3': '3. Væsentlige hændelser',
    'exec.s4': '4. Manglende kontroller',
    'exec.s5': '5. Udvikling siden sidste rapport',
    'exec.s6': '6. Anbefalede ledelsesbeslutninger',
    'exec.s7': '7. Konklusion',
    'exec.kpi.readiness': 'Modenhed',
    'exec.kpi.criticalRisks': 'Åbne kritiske risici',
    'exec.kpi.findings': 'Høje/mellem fund',
    'exec.kpi.noEvidence': 'Kontroller uden dokumentation',
    'exec.noBaseline': 'Ingen tidligere rapport at sammenligne med — denne er udgangspunktet.',
    'exec.noActions': 'Ingen udestående handlinger.',

    'concl.posture.good': 'overordnet i god form',
    'concl.posture.gaps': 'på vej, men med huller der kræver ledelsens opmærksomhed',
    'concl.posture.partial': 'kun delvist forberedt, med væsentlige huller',
    'concl.posture.early': 'tidligt i sit NIS2-arbejde, med betydelige huller',
    'concl.headline': 'Den samlede NIS2-modenhed er {score}%, hvilket betyder, at organisationen er {posture}.',
    'concl.criticalRisks': '{n} kritisk(e) risiko(er) står fortsat åbne og kræver en dokumenteret ledelsesbeslutning.',
    'concl.noEvidence': '{n} kontrol(ler) mangler aktuel dokumentation og bør prioriteres.',
    'concl.incidents': '{n} sikkerhedshændelse(r) er registreret de seneste 30 dage; enhver med underretningspligt skal vurderes hurtigst muligt.',
    'concl.clean': 'Ingen kritiske risici er åbne, og alle kontroller har dokumentation — fokus kan flyttes til at fastholde og revidere programmet.',

    'action.risk.planCritical': 'Udarbejd en handlingsplan for den kritiske risiko "{title}"',
    'action.risk.progressCritical': 'Følg op på håndteringen af den kritiske risiko "{title}"',
    'action.risk.planHigh': 'Udarbejd en handlingsplan for den høje risiko "{title}"',
    'action.control.overdue': 'Udfør den overskredne kontrol "{name}" ({area})',
    'action.control.missing': 'Etabler og dokumentér kontrollen "{name}" ({area})',
    'action.control.noEvidence': 'Vedhæft dokumentation til kontrollen "{name}" ({area})',
    'action.incident.notify': 'Vurdér NIS2-underretningspligt for hændelse {ref} "{title}"',
    'action.category.empty': 'Definér kontroller for {category} — ingen kontroller registreret endnu',

    'readiness.heading': 'Samlet modenhed: {score}%',
    'readiness.intro': 'Modenheden er gennemsnittet af de ti NIS2-kategoriscorer, som hver bygger på, hvor komplet dokumentationen for kategoriens kontroller er (OK = 100, Delvis = 50, Mangler/Overskredet = 0) — et hjælpeværktøj til selvevaluering, ikke en certificering. Åbne kritiske risici: {criticalRisks} · Høje/mellem fund: {findings} · Hændelser (30 dage): {incidents} · Kontroller uden dokumentation: {noEvidence}',
    'readiness.actions': 'Vigtigste anbefalede handlinger',

    'risk.heading': 'Risikoregister ({n})',
    'risk.intro': 'Risici for de systemer og tjenester, der er omfattet, hver vurderet som sandsynlighed × konsekvens (1–25, kolonnerne S og K) og inddelt i Lav–Kritisk. At føre dette register — med en ansvarlig, en behandlingsstatus og, hvor en risiko accepteres, en udtrykkelig ledelsesaccept — er sådan risikostyringspligten efter NIS2 (artikel 21) dokumenteres.',
    'control.heading': 'Kontroller ({n})',
    'control.intro': 'De tekniske og organisatoriske sikkerhedsforanstaltninger, der er i drift (f.eks. backup, patching, adgangsgennemgange, logning), hver knyttet til et NIS2-område med en ansvarlig og en fast kadence. NIS2 (artikel 21) kræver, at foranstaltningerne er implementeret og holdes effektive; kolonnen "Dokumentation" viser, om der findes en henvisning, der beviser, at kontrollen er udført — kontroller uden dokumentation eller markeret Mangler/Overskredet er de huller, der skal lukkes.',
    'incident.heading': 'Hændelser ({n})',
    'incident.intro': 'Sikkerhedshændelser registreret til NIS2 — hvad der skete, hvornår det blev opdaget og løst, og konsekvensen. "Underret" markerer hændelser vurderet som væsentlige, som udløser underretningspligt til den nationale CSIRT/myndighed efter NIS2 (artikel 23): en tidlig varsling inden for 24 timer, en fuld hændelsesunderretning inden for 72 timer og en endelig rapport inden for én måned. "NIS2" markerer hændelser omfattet af direktivet.',
    'art23.heading': 'Indberetning efter artikel 23 ({n})',
    'art23.intro': 'Det NIS2 artikel 23 kræver, at underretningerne indeholder, og hvornår hver af dem blev sendt. "Mistanke om ondsindet handling" og "Grænseoverskridende virkning" er de to oplysninger, den tidlige varsling skal indeholde (art. 23, stk. 4, litra a). Myndighedsreferencen er det sagsnummer, CSIRT eller den kompetente myndighed har givet hændelsen. En indsendelse markeret "for sent" blev sendt efter sin frist (24 timer, 72 timer, én måned efter underretningen). Fristens status er det værste trin, der endnu ikke er indsendt; "ikke påkrævet" betyder, at hændelsen ikke udløser underretningspligt.',
    'art23.late': '{when} (for sent)',
    'art23.crossBorderDetails': 'ja — {details}',
    'art23.eventCase': 'sag #{id}',
    'art23.notRequired': 'ikke påkrævet',
    'art23.noDetection': 'intet opdagelsestidspunkt',
    'incidents.heading': 'Sikkerhedshændelser ({n})',
    'audit.heading': 'Ændringsspor ({n})',
    'summary.heading': 'Modenhedsoverblik',
    'categories.heading': 'Kategoristatus',

    'col.metric': 'Nøgletal',
    'col.value': 'Værdi',
    'col.change': 'Ændring',
    'col.category': 'Kategori',
    'col.controls': 'Kontroller',
    'col.score': 'Score',
    'col.status': 'Status',
    'col.risk': 'Risiko',
    'col.band': 'Niveau',
    'col.owner': 'Ansvarlig',
    'col.ref': 'Ref.',
    'col.title': 'Titel',
    'col.severity': 'Alvorlighed',
    'col.nis2': 'NIS2',
    'col.notify': 'Underret',
    'col.control': 'Kontrol',
    'col.area': 'Område',
    'col.evidence': 'Dokumentation',
    'col.priority': 'Prioritet',
    'col.action': 'Handling',
    'col.id': 'ID',
    'col.asset': 'Aktiv',
    'col.likelihood': 'Sandsynlighed',
    'col.impact': 'Konsekvens',
    'col.l': 'S',
    'col.i': 'K',
    'col.mitigation': 'Handlingsplan',
    'col.due': 'Frist',
    'col.mgmtAccepted': 'Ledelsesaccept',
    'col.created': 'Oprettet',
    'col.updated': 'Opdateret',
    'col.description': 'Beskrivelse',
    'col.frequency': 'Kadence',
    'col.lastPerformed': 'Sidst udført',
    'col.nextDue': 'Næste frist',
    'col.hasEvidence': 'Har dokumentation',
    'col.comment': 'Kommentar',
    'col.detected': 'Opdaget',
    'col.started': 'Startet',
    'col.resolved': 'Løst',
    'col.affectedSystems': 'Berørte systemer',
    'col.businessImpact': 'Forretningsmæssig konsekvens',
    'col.rootCause': 'Årsag',
    'col.actionsTaken': 'Foretagne handlinger',
    'col.nis2Relevant': 'NIS2-relevant',
    'col.lessons': 'Læringspunkter',
    'col.suspectedMalicious': 'Mistanke om ondsindet handling',
    'col.crossBorder': 'Grænseoverskridende virkning',
    'col.authorityRef': 'Myndighedsreference',
    'col.earlyWarningSubmitted': 'Tidlig varsling sendt',
    'col.notificationSubmitted': 'Underretning sendt',
    'col.finalReportSubmitted': 'Endelig rapport sendt',
    'col.deadlineStatus': 'Fristens status',
    'col.eventCase': 'Sag',
    'col.when': 'Hvornår',
    'col.user': 'Bruger',
    'col.entity': 'Objekt',
    'col.entityId': 'Objekt-ID',

    'metric.readiness': 'Modenhedsscore',
    'metric.criticalRisks': 'Åbne kritiske risici',
    'metric.findings': 'Åbne høje/mellem fund',
    'metric.incidents30': 'Hændelser (seneste 30 dage)',
    'metric.incidents30short': 'Hændelser (30 dage)',
    'metric.noEvidence': 'Kontroller uden dokumentation',
    'metric.totalRisks': 'Risici i alt',
    'metric.totalControls': 'Kontroller i alt',
    'metric.totalIncidents': 'Hændelser i alt',

    'src.summary.label': 'Modenhedsoverblik',
    'src.summary.description': 'Øjebliksbilledet til direktionen: samlet modenhed i %, åbne kritiske risici, seneste hændelser og hvor mange kontroller der stadig mangler dokumentation.',
    'src.categories.label': 'Kategoristatus',
    'src.categories.description': 'Modenheden fordelt på de ti NIS2-risikostyringsområder (Ledelse og styring, Adgangsstyring, Håndtering af hændelser, …) — hvor I er dækket, og hvor hullerne er.',
    'src.risks.label': 'Risikoregister',
    'src.risks.description': 'Jeres oversigt over cyberrisici, hver vurderet som sandsynlighed × konsekvens med niveau, ansvarlig og behandlingsstatus — dokumentationen for den risikostyring, NIS2 (artikel 21) kræver.',
    'src.controls.label': 'Kontroller',
    'src.controls.description': 'De tekniske og organisatoriske sikkerhedsforanstaltninger, I driver — hver knyttet til et NIS2-område med en ansvarlig og en kadence — og om der findes en henvisning, der beviser, at foranstaltningen er udført.',
    'src.incidents.label': 'Sikkerhedshændelser',
    'src.incidents.description': 'Registrerede sikkerhedshændelser med alvorlighed, forløb og konsekvens. Markeringen "Underret" angiver væsentlige hændelser med underretningspligt til myndighed/CSIRT efter NIS2 (artikel 23) — grundlaget for den underretning.',
    'src.audit.label': 'Ændringsspor',
    'src.audit.description': 'Hvem der ændrede hvilken risiko, kontrol, hændelse eller rapport, og hvornår — den ændringshistorik, der viser, at programmet bliver holdt ved lige (kun administrator).',

    'filter.any': 'Alle',
    'filter.yes': 'Ja',
    'filter.no': 'Nej',
    'filter.minScore': 'Mindste score',
    'filter.evidencePresent': 'Har dokumentation',
    'filter.evidenceMissing': 'Mangler dokumentation',
    'filter.notificationRequired': 'Underretningspligt',
    'filter.detectedFrom': 'Opdaget fra',
    'filter.detectedTo': 'Opdaget til',

    'cat.Governance': 'Ledelse og styring',
    'cat.Risk Management': 'Risikostyring',
    'cat.Incident Response': 'Håndtering af hændelser',
    'cat.Backup/Recovery': 'Backup og genopretning',
    'cat.Access Control': 'Adgangsstyring',
    'cat.Supplier Management': 'Leverandørstyring',
    'cat.Network Security': 'Netværkssikkerhed',
    'cat.Logging/Monitoring': 'Logning og overvågning',
    'cat.Vulnerability Management': 'Sårbarhedshåndtering',
    'cat.Documentation': 'Dokumentation',
    'band.Low': 'Lav',
    'band.Medium': 'Mellem',
    'band.High': 'Høj',
    'band.Critical': 'Kritisk',
    'riskStatus.open': 'åben',
    'riskStatus.mitigating': 'under håndtering',
    'riskStatus.accepted': 'accepteret',
    'riskStatus.closed': 'lukket',
    'controlStatus.OK': 'OK',
    'controlStatus.Partial': 'Delvis',
    'controlStatus.Missing': 'Mangler',
    'controlStatus.Overdue': 'Overskredet',
    'frequency.daily': 'dagligt',
    'frequency.weekly': 'ugentligt',
    'frequency.monthly': 'månedligt',
    'frequency.quarterly': 'kvartalsvis',
    'frequency.annually': 'årligt',
    'frequency.ad-hoc': 'ad hoc',
    'severity.low': 'lav',
    'severity.medium': 'mellem',
    'severity.high': 'høj',
    'severity.critical': 'kritisk',
    'incidentStatus.open': 'åben',
    'incidentStatus.investigating': 'under undersøgelse',
    'incidentStatus.contained': 'inddæmmet',
    'incidentStatus.resolved': 'løst',
    'incidentStatus.closed': 'lukket',
    'deadlineStatus.overdue': 'overskredet',
    'deadlineStatus.due-soon': 'forfalder snart',
    'deadlineStatus.upcoming': 'kommende',
    'deadlineStatus.submitted': 'alt indsendt',
    'deadlineStatus.none': 'ingen',
    'catStatus.good': 'god',
    'catStatus.partial': 'delvis',
    'catStatus.weak': 'svag',
    'catStatus.no-data': 'ingen data',
    'entityType.risk': 'risiko',
    'entityType.control': 'kontrol',
    'entityType.incident': 'hændelse',
    'entityType.report': 'rapport',
    'entityType.evidence': 'dokumentation',
    'priority.critical': 'kritisk',
    'priority.high': 'høj',
    'priority.medium': 'mellem',
  },
};

// The BCP-47 tag that goes in <html lang> and drives toLocaleString for the
// document's dates. en-GB, not en-US: this is a European product (see CLAUDE.md)
// and 04/09 must not read as April on a compliance document.
const HTML_LANG = Object.freeze({ en: 'en-GB', da: 'da-DK' });

function isLocale(v) {
  return typeof v === 'string' && LOCALES.includes(v);
}

// Accepts a locale name, a BCP-47 tag ('da-DK'), or an Accept-Language header
// ('da,en;q=0.8'). Anything unrecognised falls back to English rather than
// throwing — a report must render.
function resolveLocale(value) {
  if (isLocale(value)) return value;
  if (typeof value !== 'string' || !value) return DEFAULT_LOCALE;
  for (const part of value.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  ));
}

// Returns a lookup bound to one locale. Nothing is cached across calls, so two
// concurrent requests in different languages cannot collide.
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
  // Enum values arrive from the database, so an unknown one (an older row, a
  // value added to the schema but not here) has to pass through untouched
  // rather than render as "controlStatus.Whatever".
  t.enum = (prefix, value) => {
    if (value === null || value === undefined || value === '') return '';
    const k = `${prefix}.${value}`;
    if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
    if (Object.prototype.hasOwnProperty.call(fallback, k)) return fallback[k];
    return String(value);
  };
  t.yesNo = (v) => (v ? t('doc.yes') : t('doc.no'));
  t.locale = loc;
  t.htmlLang = HTML_LANG[loc] || HTML_LANG[DEFAULT_LOCALE];
  return t;
}

// Keys present in en but missing from `locale` — the parity check's input.
function missingKeys(locale) {
  const en = STRINGS[DEFAULT_LOCALE];
  const table = STRINGS[locale] || {};
  return Object.keys(en).filter((k) => !Object.prototype.hasOwnProperty.call(table, k));
}

module.exports = { LOCALES, DEFAULT_LOCALE, STRINGS, HTML_LANG, isLocale, resolveLocale, createT, missingKeys };
