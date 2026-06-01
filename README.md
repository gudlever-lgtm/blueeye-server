# blueeye-server

On-prem, single-tenant API-server til BlueEye. Bygget på **Node.js + Express**
med **MySQL** som datalager. Kører fuldt ud på egen infrastruktur — ingen
ekstern SaaS, ingen telemetri.

## Afhængigheder

Kun open source-komponenter med tilladende licenser (MIT/BSD):

| Pakke         | Licens | Rolle                          |
| ------------- | ------ | ------------------------------ |
| express       | MIT    | HTTP-framework / routing       |
| mysql2        | MIT    | MySQL-driver (pool, promises)  |
| jsonwebtoken  | MIT    | Udsted/verificér JWT           |
| bcryptjs      | MIT    | Password-hashing (ren JS)      |
| ws            | MIT    | WebSocket (agent live-kanal)   |
| dotenv        | BSD-2  | Indlæsning af `.env`           |
| supertest     | MIT    | HTTP-tests (kun `devDeps`)     |

`bcryptjs` er valgt frem for native `bcrypt`/`argon2`, fordi den er ren
JavaScript og dermed ikke kræver et build-trin — nemt at deploye on-prem på
tværs af hosts. Hashing er isoleret i [`src/auth/password.js`](src/auth/password.js),
så algoritmen kan udskiftes uden at røre kaldere.

Testkørsel bruger Node's indbyggede test runner (`node --test`) — ingen ekstra
test-framework nødvendig.

## Krav

- Node.js >= 20 (udviklet og testet på Node 22)
- En MySQL-server (8.x anbefales)

## Kom i gang

```bash
# 1) Installér afhængigheder
npm install

# 2) Opret konfiguration og ret værdierne til
cp .env.example .env

# 3) Opret databasen i MySQL (engangsopgave)
#    CREATE DATABASE blueeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# 4) Kør migrationer (opretter tabeller)
npm run migrate

# 5) Start serveren
npm start          # produktion
npm run dev        # udvikling, genstarter ved filændringer
```

Serveren lytter som standard på port `3000` (kan ændres med `PORT`).

## Konfiguration

Al konfiguration sker via miljøvariabler (se [`.env.example`](.env.example)):

| Variabel              | Standard    | Beskrivelse                       |
| --------------------- | ----------- | --------------------------------- |
| `NODE_ENV`            | development | Kørselsmiljø                      |
| `PORT`                | 3000        | HTTP-port                         |
| `DB_HOST`             | 127.0.0.1   | MySQL-host                        |
| `DB_PORT`             | 3306        | MySQL-port                        |
| `DB_USER`             | blueeye     | DB-bruger                         |
| `DB_PASSWORD`         | (tom)       | DB-adgangskode                    |
| `DB_NAME`             | blueeye     | Databasenavn                      |
| `DB_CONNECTION_LIMIT` | 10          | Maks. antal forbindelser i pool   |
| `JWT_SECRET`          | (dev-værdi) | Nøgle til at signere JWT          |
| `JWT_EXPIRES_IN`      | 12h         | JWT-levetid                       |
| `JWT_ISSUER`          | blueeye-server | `iss`-claim på tokens          |
| `BCRYPT_ROUNDS`       | 12          | bcrypt cost-faktor                |
| `SEED_ADMIN_EMAIL`    | admin@blueeye.local | Email på den seedede admin |
| `SEED_ADMIN_PASSWORD` | (tom)       | Adgangskode; genereres hvis tom   |
| `ENROLLMENT_CODE_TTL_MINUTES` | 60  | Standard-levetid for enrollment-koder |
| `WS_AGENT_PATH`       | /ws/agent   | Sti for agent-WebSocket           |
| `WS_HEARTBEAT_MS`     | 30000       | Heartbeat-interval (ping) i ms    |

> I produktion (`NODE_ENV=production`) nægter serveren at starte, hvis
> `JWT_SECRET` ikke er ændret fra dev-standardværdien.

## Database

- [`schema.sql`](schema.sql) — komplet schema-snapshot. Kan indlæses direkte i
  en frisk database: `mysql -u <bruger> -p <db> < schema.sql`.
- [`migrations/`](migrations) — nummererede SQL-migrationer, der køres i
  rækkefølge. `migrations/` er kilden til sandhed for inkrementelle ændringer.
- [`src/migrate.js`](src/migrate.js) — simpel migrationskørsel. Holder styr på
  allerede kørte migrationer i tabellen `schema_migrations`, så `npm run migrate`
  er sikker at køre gentagne gange. Tilføj en ny migration ved at lægge en fil
  `NNN_beskrivelse.sql` i `migrations/`. Efter migrationerne **seedes en
  admin-bruger**, hvis ingen admin findes (se nedenfor).

### `locations`

| Kolonne       | Type            | Noter                                  |
| ------------- | --------------- | -------------------------------------- |
| `id`          | INT UNSIGNED PK | Auto-increment                         |
| `name`        | VARCHAR(255)    | Påkrævet, fx `"Aarhus – Hovedkontor"`  |
| `description` | TEXT            | Valgfri (nullable)                     |
| `created_at`  | TIMESTAMP       | Sættes automatisk                      |
| `updated_at`  | TIMESTAMP       | Opdateres automatisk ved ændring       |

### `users`

| Kolonne         | Type            | Noter                                   |
| --------------- | --------------- | --------------------------------------- |
| `id`            | INT UNSIGNED PK | Auto-increment                          |
| `email`         | VARCHAR(255)    | Unik                                    |
| `password_hash` | VARCHAR(255)    | bcrypt-hash (aldrig klartekst)          |
| `role`          | ENUM            | `admin` / `operator` / `viewer`         |
| `created_at`    | TIMESTAMP       | Sættes automatisk                       |
| `updated_at`    | TIMESTAMP       | Opdateres automatisk ved ændring        |

**Seed af admin:** Ved migrationskørsel oprettes én admin-bruger, hvis der ikke
allerede findes en. Email tages fra `SEED_ADMIN_EMAIL`. Er `SEED_ADMIN_PASSWORD`
sat, bruges den; ellers genereres en stærk adgangskode, som printes **én gang**
til konsollen — gem den med det samme.

### `agents`

Felterne er delt i to grupper: **agent-rapporterede** (skrives af agenten selv
ved enrollment/heartbeat) og **server-styrede** (sættes af operatører/admins via
API'et). `PUT /agents/:id` rører kun de server-styrede felter.

| Kolonne         | Gruppe          | Type            | Noter                                   |
| --------------- | --------------- | --------------- | --------------------------------------- |
| `id`            | —               | INT UNSIGNED PK | Auto-increment                          |
| `hostname`      | agent-rapport.  | VARCHAR(255)    | Påkrævet                                |
| `platform`      | agent-rapport.  | VARCHAR(64)     | fx `linux`, `win32`                     |
| `arch`          | agent-rapport.  | VARCHAR(32)     | fx `x64`, `arm64`                       |
| `last_seen`     | agent-rapport.  | DATETIME        | Nullable                                |
| `status`        | agent-rapport.  | ENUM            | `online` / `offline` (default `offline`)|
| `location_id`   | server-styret   | INT UNSIGNED FK | → `locations(id)` `ON DELETE SET NULL`  |
| `display_name`  | server-styret   | VARCHAR(255)    | Nullable                                |
| `notes`         | server-styret   | TEXT            | Nullable                                |
| `meta`          | server-styret   | JSON            | Nullable                                |
| `created_at`    | —               | TIMESTAMP       | Sættes automatisk                       |
| `updated_at`    | —               | TIMESTAMP       | Opdateres automatisk ved ændring        |

Selve oprettelsen af agents sker via **enrollment** (se [Enrollment](#enrollment))
— der er bevidst ingen manuel `POST /agents`.

### `enrollment_codes`

Engangskoder til at enrolle nye agents. Selve `code` er tilfældig og unik og
returneres kun til operatøren **én gang** ved oprettelse — listen viser den aldrig.

| Kolonne       | Type            | Noter                                   |
| ------------- | --------------- | --------------------------------------- |
| `id`          | INT UNSIGNED PK | Auto-increment                          |
| `code`        | VARCHAR(64)     | Unik, tilfældig                         |
| `location_id` | INT UNSIGNED FK | Nullable → `locations(id)` `SET NULL`   |
| `created_by`  | INT UNSIGNED FK | → `users(id)`                           |
| `expires_at`  | DATETIME        | Udløbstidspunkt                         |
| `used_at`     | DATETIME        | Nullable; sættes når koden bruges       |
| `created_at`  | TIMESTAMP       | Sættes automatisk                       |

### `agent_tokens`

Opaque agent-tokens. **Kun SHA-256-hashen gemmes** — aldrig selve tokenet.

| Kolonne        | Type            | Noter                                   |
| -------------- | --------------- | --------------------------------------- |
| `id`           | INT UNSIGNED PK | Auto-increment                          |
| `agent_id`     | INT UNSIGNED FK | Nullable → `agents(id)` `ON DELETE CASCADE` |
| `token_hash`   | VARCHAR(64)     | Unik (SHA-256 hex)                      |
| `created_at`   | TIMESTAMP       | Sættes automatisk                       |
| `last_used_at` | DATETIME        | Nullable                                |
| `revoked_at`   | DATETIME        | Nullable                                |

### `results`

Testresultater rapporteret af agents (via REST, agent-token-autentificeret).

| Kolonne      | Type            | Noter                                   |
| ------------ | --------------- | --------------------------------------- |
| `id`         | INT UNSIGNED PK | Auto-increment                          |
| `agent_id`   | INT UNSIGNED FK | → `agents(id)` `ON DELETE CASCADE`      |
| `payload`    | JSON            | Selve resultatet                        |
| `created_at` | TIMESTAMP       | Sættes automatisk                       |

## API

De fleste endpoints kræver et bruger-JWT i `Authorization: Bearer <token>` og
adgang afgøres af rollen (se [Autorisation](#autorisation-rbac)). Undtagelser:
`/health`, `/auth/login` og `/agents/enroll` er åbne, mens `/agents/results` og
WebSocket-kanalen bruger et **agent-token** (ikke et JWT) — se
[Agent-kommunikation](#agent-kommunikation).

| Metode | Sti              | Beskrivelse                       | Rolle              | Svar                       |
| ------ | ---------------- | --------------------------------- | ------------------ | -------------------------- |
| GET    | `/health`        | Liveness — tjekker DB-forbindelse | (åben)             | `200` (DB oppe) / `503`    |
| POST   | `/auth/login`    | Log ind, få et JWT                | (åben)             | `200` + token / `401`      |
| GET    | `/locations`     | Hent alle locations               | viewer+            | `200` med array            |
| POST   | `/locations`     | Opret en location                 | operator+          | `201` / `400`              |
| PUT    | `/locations/:id` | Opdatér en location               | operator+          | `200` / `404` / `400`      |
| DELETE | `/locations/:id` | Slet en location                  | admin              | `204` / `404` / `400`      |
| GET    | `/users`         | Hent alle brugere                 | admin              | `200` med array            |
| POST   | `/users`         | Opret bruger (hasher password)    | admin              | `201` / `400` / `409`      |
| PUT    | `/users/:id`     | Opdatér rolle (+ valgfri reset)   | admin              | `200` / `404` / `400` / `409` |
| DELETE | `/users/:id`     | Slet bruger (ej sidste admin)     | admin              | `204` / `404` / `409`      |
| GET    | `/agents`        | Hent alle agents (join location)  | viewer+            | `200` med array            |
| GET    | `/agents/:id`    | Hent én agent                     | viewer+            | `200` / `404` / `400`      |
| PUT    | `/agents/:id`    | Opdatér KUN server-styrede felter | operator+          | `200` / `404` / `400`      |
| DELETE | `/agents/:id`    | Slet en agent                     | admin              | `204` / `404` / `400`      |
| POST   | `/agents/enroll` | Enroll agent med kode             | (åben)             | `201` / `400` / `401` / `410` |
| POST   | `/enrollment-codes` | Generér engangskode            | operator+          | `201` (kode én gang) / `400` |
| GET    | `/enrollment-codes` | Liste m. status (uden kode)    | operator+          | `200` med array            |
| DELETE | `/enrollment-codes/:id` | Slet en kode               | admin              | `204` / `404` / `400`      |
| POST   | `/agents/results` | Indsend testresultater           | **agent-token**    | `201` / `400` / `401`      |
| GET    | `/agents/:id/results` | Hent en agents resultater    | viewer+            | `200` / `404` / `400`      |
| GET    | `/license/status` | Lokal licensstatus               | viewer+            | `200`                      |
| GET    | `/api/findings`  | Listér analyse-findings           | viewer+            | `200` / `400` (ugyldig since) |
| POST   | `/api/findings/:id/ack` | Kvittér en finding         | operator+          | `200` / `404`              |
| POST   | `/api/assistant/explain` | Spørg AI-assistenten (opt-in) | viewer+        | `200` / `400` / `403` / `500` |
| WS     | `/ws/agent`      | Live-kanal (status/kommandoer)    | **agent-token**    | upgrade / hård luk         |
| WS     | `/ws/dashboard`  | Live findings til dashboardet     | viewer+ (JWT)      | upgrade / hård luk         |

("viewer+" = viewer eller højere; "operator+" = operator eller admin.
"agent-token" = opaque agent-token, ikke bruger-JWT.)

Analyse-modulet (lokal anomali-detektion, korrelator og opt-in AI-assistent) er
beskrevet i [`docs/analysis.md`](docs/analysis.md).

### Eksempler

```bash
# Log ind og gem token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@blueeye.local","password":"<password>"}' | jq -r .token)

# Hent alle locations (kræver mindst viewer)
curl http://localhost:3000/locations -H "Authorization: Bearer $TOKEN"

# Opret en location (kræver operator+)
curl -X POST http://localhost:3000/locations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Aarhus – Hovedkontor","description":"Hovedsæde"}'

# Slet en location (kræver admin)
curl -X DELETE http://localhost:3000/locations/1 -H "Authorization: Bearer $TOKEN"

# Opret en bruger (kræver admin)
curl -X POST http://localhost:3000/users \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"ops@blueeye.local","password":"et-langt-password","role":"operator"}'
```

### Fejlsvar

Fejl returneres som JSON. Statuskoder:

- `400` — valideringsfejl eller ugyldigt `:id`
- `401` — manglende/ugyldigt/udløbet token, eller forkerte login-oplysninger
- `403` — gyldigt token, men rollen har ikke adgang
- `404` — ukendt sti eller ressource findes ikke
- `409` — konflikt (fx dublet-email, eller forsøg på at slette sidste admin)
- `500` — uventet serverfejl (fx databasen er nede under en forespørgsel)
- `503` — `/health` når databasen ikke svarer

## Autorisation (RBAC)

Login via `POST /auth/login` returnerer et JWT, der bæres i
`Authorization: Bearer <token>`. To middleware håndhæver adgang
([`src/auth/middleware.js`](src/auth/middleware.js)):

- `requireAuth` — kræver et gyldigt JWT, ellers `401`.
- `requireRole(...roller)` — kræver at brugerens rolle er blandt de angivne,
  ellers `403`.

Tre roller med stigende rettigheder:

| Handling                              | viewer | operator | admin |
| ------------------------------------- | :----: | :------: | :---: |
| Læse locations (GET)                  |   ✓    |    ✓     |   ✓   |
| Oprette/redigere locations (POST/PUT) |   –    |    ✓     |   ✓   |
| Slette locations (DELETE)             |   –    |    –     |   ✓   |
| Læse agents (GET)                     |   ✓    |    ✓     |   ✓   |
| Redigere agent-metadata (PUT)         |   –    |    ✓     |   ✓   |
| Slette agents (DELETE)                |   –    |    –     |   ✓   |
| Brugeradministration (`/users`)       |   –    |    –     |   ✓   |
| Oprette/liste enrollment-koder        |   –    |    ✓     |   ✓   |
| Slette enrollment-koder               |   –    |    –     |   ✓   |

JWT signeres med HS256 og `JWT_SECRET`; algoritmen pinnes ved verificering for
at undgå algorithm-confusion. Adgangskoder hashes med bcrypt og gemmes aldrig i
klartekst.

## Enrollment

Nye agents oprettes via enrollment — ikke manuelt. Flowet:

1. **Operatør/admin genererer en kode:** `POST /enrollment-codes` (valgfri
   `location_id`, valgfri `expiresInMinutes`, default 1 time). Koden returneres
   i klartekst **én gang** — gem den til agenten.
2. **Agenten enroller sig selv:** `POST /agents/enroll { code, hostname,
   platform, arch }` — **uden** auth (agenten har endnu intet token). Serveren:
   - validerer koden (findes → ellers `401`; brugt/udløbet → `410`),
   - opretter en agent-række med agent-rapporterede felter + `location_id` fra koden,
   - genererer et **opaque token** (ikke et JWT), gemmer dets SHA-256-hash og
     markerer koden som brugt — alt i én transaktion med rækken låst, så en kode
     aldrig kan bruges to gange,
   - returnerer `{ agentId, token }` i klartekst **én gang**.

Agent-tokens er opaque tilfældige strenge. De gemmes kun som hash; mister man
tokenet, må agenten enrolles på ny. Hele claim-and-enroll er atomisk
([`src/services/enrollmentStore.js`](src/services/enrollmentStore.js)).

```bash
# 1) Operatør genererer en kode (med et operator/admin-token)
curl -s -X POST http://localhost:3000/enrollment-codes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"location_id":1}'
# -> { "id":1, "code":"<engangskode>", "expires_at":"...", ... }

# 2) Agenten enroller sig selv (ingen auth)
curl -s -X POST http://localhost:3000/agents/enroll \
  -H 'Content-Type: application/json' \
  -d '{"code":"<engangskode>","hostname":"node-01","platform":"linux","arch":"x64"}'
# -> { "agentId":7, "token":"<opaque-token>" }
```

## Agent-kommunikation

Agents bruger deres **opaque token** (fra enrollment) — ikke et bruger-JWT.
Token-auth og bruger-JWT-auth er holdt i to separate middlewares
([`src/auth/agentAuth.js`](src/auth/agentAuth.js) hhv.
[`src/auth/middleware.js`](src/auth/middleware.js)). Indkommende agent-tokens
hashes (SHA-256) og slås op i `agent_tokens`; ukendte eller tilbagekaldte tokens
afvises. Ved gyldig auth opdateres `last_used_at` og `agents.last_seen`.

**WebSocket — `/ws/agent`** (live status + kommandoer):

- Agenten sender sit token i `Authorization: Bearer <token>` **eller** som
  `?token=<token>` i URL'en ved connect.
- Uden gyldigt token afvises handshaket **hårdt** (HTTP `401` under upgrade — der
  oprettes aldrig en WebSocket).
- Ved connect sættes `status = online`; ved disconnect `status = offline`.
- Server-ping (heartbeat) holder `last_seen` frisk; forbindelser uden svar lukkes.
- Server→agent: serveren kan pushe kommandoer (fx `run test`) til en agents
  aktive forbindelser.

**REST** (agent-token):

- `POST /agents/results { results: [ {...} ] }` — gemmer hvert element som en
  `results`-række knyttet til `agent_id` fra tokenet.

Resultater læses tilbage af brugere via `GET /agents/:id/results` (bruger-JWT,
viewer+).

```bash
# Agenten indsender resultater med sit opaque token
curl -X POST http://localhost:3000/agents/results \
  -H "Authorization: Bearer <agent-token>" -H 'Content-Type: application/json' \
  -d '{"results":[{"test":"ping","ok":true}]}'
```

## Licens-validering (mod blueeye-licens)

Serveren validerer sin egen licens mod den centrale `blueeye-licens`. Det
signerede svar bruges **kun** som licensbevis — **aldrig** som adgangstoken.
Agent-tokens udstedes og valideres udelukkende lokalt; licensserveren rører dem aldrig.

**Konfiguration (sættes ved installation, ikke CRUD)** — via env (se
[`.env.example`](.env.example)) eller `src/license/publicKey.js`:

| Variabel | Beskrivelse |
| --- | --- |
| `LICENSE_KEY` | Licensnøgle udstedt af blueeye-licens |
| `LICENSE_SERVER_ID` | Denne servers id (skal matche `payload.serverId`) |
| `LICENSE_SERVER_URL` | blueeye-licens URL |
| `LICENSE_PUBLIC_KEY` | Indlejret Ed25519 public key (overstyrer `src/license/publicKey.js`) |
| `LICENSE_GRACE_DAYS` | Offline grace-periode (default 14) |
| `LICENSE_VALIDATE_INTERVAL_HOURS` | Valideringsinterval (default 6) |

Den indlejrede public key kommer fra `docs/public-key.md` i blueeye-licens.

**Logik:**

- Ved opstart + hver 6. time: `POST /validate` med `{ licenseKey, serverId, agentCount }`.
- Svaret verificeres: kanonisk JSON af `payload` reproduceres med **samme
  `canonicalize()`** som blueeye-licens (kopieret byte-for-byte ind i
  [`src/lib/canonicalize.js`](src/lib/canonicalize.js)) og signaturen tjekkes mod
  den indlejrede public key.
- Svaret **afvises** hvis signaturen er ugyldig **eller** `payload.serverId` ≠ egen
  `serverId` (falder tilbage på cache).
- Sidste gyldige (verificerede) validering caches på disk (`LICENSE_CACHE_PATH`).
- **Offline grace:** kan serveren ikke validere, bruges den cachede validering i op
  til 14 dage; derefter **hård fejl** (ulicenseret).
- **max_agents håndhæves lokalt:** nye agent-WebSocket-connects afvises (`403`),
  når antallet ville overskride grænsen, eller når licensen ikke er gyldig.

Status kan ses via `GET /license/status` (viewer+).

> `blueeye-server` skal indlejre blueeye-licens' public key i
> `src/license/publicKey.js` (eller `LICENSE_PUBLIC_KEY`). Indtil da fejler al
> verifikation, og serveren er ulicenseret.

## Projektstruktur

```
blueeye-server/
├── migrations/                 # Nummererede SQL-migrationer
│   ├── 001_create_locations.sql
│   ├── 002_create_users.sql
│   ├── 003_create_agents.sql
│   ├── 004_create_enrollment.sql
│   └── 005_create_results.sql
├── schema.sql                  # Fuldt schema-snapshot
├── src/
│   ├── app.js                  # Express app-factory (uden listen)
│   ├── server.js               # Entrypoint: wiring + listen + WS + shutdown
│   ├── migrate.js              # Migrationskørsel + admin-seed
│   ├── config.js               # Env-baseret konfiguration
│   ├── db.js                   # MySQL connection pool + helpers
│   ├── logger.js               # Stille standard-logger til tests
│   ├── auth/                   # JWT + agent-token (to separate auth-systemer)
│   ├── lib/                    # canonicalize (byte-identisk med blueeye-licens)
│   ├── license/                # verify, publicKey, cache, licenseManager
│   ├── middleware/             # asyncHandler, fejlhåndtering, request-log
│   ├── repositories/           # Dataadgang (locations, users, agents, tokens, results …)
│   ├── services/               # enrollmentStore (atomisk claim-and-enroll)
│   ├── routes/                 # health, auth, users, locations, agents, enrollment, license …
│   ├── validation/             # Input-validering
│   └── ws/                     # agentSocket (WebSocket live-kanal)
├── test/                       # Tests (node --test + supertest + ws)
└── test-support/               # Test-fakes (uden for test/)
```

## Test

```bash
npm test
```

Testene kører mod app-factory'en med injicerede fakes — der kræves **ingen
kørende database**. Dækningen omfatter login (gyldig/forkert → `401`), beskyttede
endpoints uden token (`401`), for lav rolle (`403`), `400`/`404`/`409`/`500` for
alle endpoints, enrollment (`401`/`410`), POST results med/uden agent-token
(`401`), samt WebSocket-connect med gyldigt/ugyldigt token (en rigtig
HTTP+WebSocket-server startes i testen). For licens-validering: gyldig validering,
ugyldig signatur, forkert serverId, offline med gyldig cache, offline efter grace
udløbet, agent over grænse, samt at `canonicalize()` matcher blueeye-licens
byte-for-byte.
