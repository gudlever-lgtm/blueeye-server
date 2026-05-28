# blueeye-server

On-prem, single-tenant API-server til BlueEye. Bygget på **Node.js + Express**
med **MySQL** som datalager. Kører fuldt ud på egen infrastruktur — ingen
ekstern SaaS, ingen telemetri.

## Afhængigheder

Kun open source-komponenter med tilladende licenser (MIT/BSD):

| Pakke      | Licens | Rolle                          |
| ---------- | ------ | ------------------------------ |
| express    | MIT    | HTTP-framework / routing       |
| mysql2     | MIT    | MySQL-driver (pool, promises)  |
| dotenv     | BSD-2  | Indlæsning af `.env`           |
| supertest  | MIT    | HTTP-tests (kun `devDeps`)     |

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

## Database

- [`schema.sql`](schema.sql) — komplet schema-snapshot. Kan indlæses direkte i
  en frisk database: `mysql -u <bruger> -p <db> < schema.sql`.
- [`migrations/`](migrations) — nummererede SQL-migrationer, der køres i
  rækkefølge. `migrations/` er kilden til sandhed for inkrementelle ændringer.
- [`src/migrate.js`](src/migrate.js) — simpel migrationskørsel. Holder styr på
  allerede kørte migrationer i tabellen `schema_migrations`, så `npm run migrate`
  er sikker at køre gentagne gange. Tilføj en ny migration ved at lægge en fil
  `NNN_beskrivelse.sql` i `migrations/`.

### `locations`

| Kolonne       | Type            | Noter                                  |
| ------------- | --------------- | -------------------------------------- |
| `id`          | INT UNSIGNED PK | Auto-increment                         |
| `name`        | VARCHAR(255)    | Påkrævet, fx `"Aarhus – Hovedkontor"`  |
| `description` | TEXT            | Valgfri (nullable)                     |
| `created_at`  | TIMESTAMP       | Sættes automatisk                      |
| `updated_at`  | TIMESTAMP       | Opdateres automatisk ved ændring       |

## API

| Metode | Sti              | Beskrivelse                       | Svar                         |
| ------ | ---------------- | --------------------------------- | ---------------------------- |
| GET    | `/health`        | Liveness — tjekker DB-forbindelse | `200` (DB oppe) / `503`      |
| GET    | `/locations`     | Hent alle locations               | `200` med array              |
| POST   | `/locations`     | Opret en location                 | `201` med oprettet objekt    |
| PUT    | `/locations/:id` | Opdatér en location               | `200` / `404` / `400`        |
| DELETE | `/locations/:id` | Slet en location                  | `204` / `404` / `400`        |

### Eksempler

```bash
# Sundhedstjek
curl http://localhost:3000/health

# Opret
curl -X POST http://localhost:3000/locations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Aarhus – Hovedkontor","description":"Hovedsæde"}'

# Hent alle
curl http://localhost:3000/locations

# Opdatér
curl -X PUT http://localhost:3000/locations/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Aarhus – Hovedkontor","description":"Opdateret"}'

# Slet
curl -X DELETE http://localhost:3000/locations/1
```

### Fejlsvar

Fejl returneres som JSON. Statuskoder:

- `400` — valideringsfejl eller ugyldigt `:id`
- `404` — ukendt sti eller location findes ikke
- `500` — uventet serverfejl (fx databasen er nede under en forespørgsel)
- `503` — `/health` når databasen ikke svarer

## Autorisation (RBAC)

Endpoints er **åbne indtil videre**. Koden er struktureret, så RBAC let kan
sættes på i et senere trin: authentication/authorization-middleware kan mountes
globalt i [`src/app.js`](src/app.js) eller pr. router/route i
[`src/routes/locations.js`](src/routes/locations.js) — uden at ændre selve
handler-logikken.

## Projektstruktur

```
blueeye-server/
├── migrations/                 # Nummererede SQL-migrationer
│   └── 001_create_locations.sql
├── schema.sql                  # Fuldt schema-snapshot
├── src/
│   ├── app.js                  # Express app-factory (uden listen)
│   ├── server.js               # Entrypoint: wiring + listen + shutdown
│   ├── migrate.js              # Migrationskørsel
│   ├── config.js               # Env-baseret konfiguration
│   ├── db.js                   # MySQL connection pool + helpers
│   ├── logger.js               # Stille standard-logger til tests
│   ├── middleware/             # asyncHandler, fejlhåndtering, request-log
│   ├── repositories/           # Dataadgang (locations)
│   ├── routes/                 # health + locations routers
│   └── validation/             # Input-validering
├── test/                       # Tests (node --test + supertest)
└── test-support/               # Test-fakes (uden for test/)
```

## Test

```bash
npm test
```

Testene kører mod app-factory'en med injicerede fakes — der kræves **ingen
kørende database**. Alle endpoints dækkes for både `404`- og `500`-stier samt
de øvrige statuskoder.
