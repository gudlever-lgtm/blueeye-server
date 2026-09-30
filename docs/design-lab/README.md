# Design lab — "Floating enterprise" (eksperiment)

`floating-enterprise.html` er en **selvstændig prototype**. Den ligger bevidst i
`docs/`, ikke i `public/`: den er ikke serveret, ikke routet, ikke omfattet af
`ui:check` og ændrer ikke en pixel i appen. Åbn filen direkte i en browser.
Knappen ◐ i toppen skifter mellem lyst og mørkt tema.

Prototypen viser hele skalaen på én side: shell + rail, topbar, KPI-kort,
widgets, tabel, statusindikatorer, dropdown, modal, drawer, formfelter,
knapper, topologi og responsiv reflow ved 1100 px og 760 px.

## Hvad prototypen foreslår konkret

| Område | Forslag |
|---|---|
| Elevation | Fire niveauer som **par** af skygge *og* overflade (`--elev-1` … `--elev-4`, `--elev-N-surface`) |
| Kort | 1 px hairline + 2-lags skygge i hvile, 12 px radius |
| Hover | Kun skyggeskift + kantfarve — ingen `translateY` |
| Accent | `#0284c7` dæmpet til `#0b6fa4`; accent bruges kun til interaktion |
| Status | 7 px prik + tekst i stedet for farvede badges |
| Rækkehøjde | 44 px (appens nuværende `--row-h`), ikke 48–56 px |
| Spacing | Appens eksisterende `--s-1` … `--s-6` — ingen ny skala |
| Loading | 2 px koboltblå linje i toppen (`--loading`), over alt andet |

## Loadingslinjen

2 px i toppen af viewporten, koboltblå, `z-index` over modaler og toasts.
Tre detaljer der gør forskellen mellem en pæn og en irriterende linje:

- **Forsinket visning.** Den dukker først op efter 150 ms. Svar under den
  grænse viser ingenting — ellers blinker toppen ved hvert eneste klik.
- **Ubestemt forløb.** Den kender ikke den faktiske fremdrift, så den kryber
  asymptotisk mod 90 % og springer til 100 % når svaret er hjemme. Ingen falsk
  procentangivelse.
- **Tællende.** To parallelle kald slukker ikke for hinanden; linjen forsvinder
  først når den sidste er færdig.

Kuløren er bevidst den samme i alle temaer (hævet luminans på mørk bund, ellers
forsvinder kobolt). Den er systemfeedback, ikke brandfarve. Den er også den
eneste undtagelse fra `prefers-reduced-motion`: uden bevægelse siger den intet.

## Forbedringer i forhold til oplægget

Oplægget er godt, men syv punkter ville give problemer i netop dette repo.

**1. Ingen parallel token-skala.** Oplægget indfører `--bg-page`, `--space-4`,
`--radius-md`, `--shadow-card`. `public/css/tokens.css` har allerede
`--bg`, `--s-4`, `--radius`, `--shadow` — og 16 temaer bygget ovenpå. To navne
for samme farve betyder at halvdelen af temaerne før eller siden kun får det
ene sæt opdateret. Udvid det eksisterende vokabular i stedet.

**2. Skygger alene bærer ikke dybde på mørk bund.** Oplæggets skygger er faste
`rgba(0,0,0,…)`-værdier, som er usynlige på de 7 mørke temaer. BlueEye har
mørkt tema som standard (NOC-brug). Derfor er elevation her defineret som et
par: skygge **plus** et overfladetrin. Mørkt tema lysner overfladen pr. niveau,
lyst tema holder hvid og lader skyggen gøre arbejdet. Samme hierarki, begge
steder.

**3. Tre skyggelag på hvert kort er for dyrt.** Et dashboard med 4 KPI-kort +
6 widgets = 30 blur-lag, som males om ved hvert hover og hver scroll. To lag i
hvile, tre kun på overlays (popover, modal, drawer), giver visuelt det samme og
koster mærkbart mindre på svage klienter.

**4. `translateY(-1px)` på hover skal droppes.** I et CSS Grid-dashboard giver
det en synlig rysten når musen glider hen over en kortrække, og det respekterer
ikke `prefers-reduced-motion`. Løft med skygge, ikke med position.

**5. "Undgå stærkt blåt" kolliderer med accenten.** `#0284c7` *er* stærkt
korporativt blåt. Prototypen bruger `#0b6fa4` — samme kulør, lavere mætning,
stadig genkendelig som BlueEye. Til gengæld: accent kun på interaktion
(fokus, primærknap, aktivt nav-punkt). Status er semantisk og aldrig accent.

**6. 48–56 px rækker er for luftigt her.** Flådevisningen har hundredvis af
rækker; ved 56 px ser man 9 ad gangen på en bærbar. Behold `--row-h: 44px` og
`--row-h-compact: 36px` med den eksisterende densitets-toggle.

**7. Navigationen kan ikke bare omdøbes.** Oplæggets menu (Devices, Incidents,
Insights …) matcher ikke BlueEyes IA. Sidebaren er statisk markup med
`data-i18n`-attributter, og hvert punkt hænger sammen med `public/routes.js`,
`PAGE_INFO` og gate-sweepet. En omdøbning er et IA-projekt, ikke et CSS-projekt
— hold dem adskilt.

**Bonus: hover på tabelrækker.** `rgba(0,0,0,.018)` er under synlighedsgrænsen
på de fleste skærme og forsvinder helt på mørk bund. Brug den eksisterende
`--hover` (`color-mix` af `--muted`), der virker i alle 16 temaer.

## Hvis retningen godkendes — anbefalet rækkefølge

Ikke en big bang. Kontrakten i `docs/ui-contract.md` findes allerede, og
`ui:check` har en `MIGRATED`-liste, der kun vokser:

1. `tokens.css`: tilføj `--elev-1…4` + `--elev-*-surface`, dæmp accenten.
2. `components.css`: `.card`, `.btn`, `.input`, `.table`, popover, modal,
   drawer læser de nye tokens. Ingen skærm ændres endnu.
3. `/ui-kitchen-sink` bliver review-fladen — alt i alle tilstande, alle temaer.
4. Én skærm ad gangen, hver med sin `MIGRATED`-linje i samme commit.
5. Til sidst responsiv gennemgang og en runde i alle 16 temaer.

Ingen route, intet API, ingen auth og ingen DB røres undervejs.
