# oracle-schema-diff

[![npm version](https://img.shields.io/npm/v/oracle-schema-diff.svg)](https://www.npmjs.com/package/oracle-schema-diff)
[![license](https://img.shields.io/npm/l/oracle-schema-diff.svg)](LICENSE)
[![node](https://img.shields.io/node/v/oracle-schema-diff.svg)](package.json)

A CLI tool that compares two Oracle Database schemas and generates SQL migration scripts to bring the target (e.g. PROD) in sync with the source (e.g. SIT/UAT).

Also generates a **5-tab visual HTML report** with relationship graphs, drift summaries, and issue tables.

## Install

```bash
# Global install — gives you the oracle-schema-diff command everywhere
npm install -g oracle-schema-diff
```

```bash
# Zero-install via npx (no global install needed)
npx oracle-schema-diff
```

## Prerequisites

- **Node.js** >= 14
- **Oracle Instant Client** installed (if using thick mode)
- Network access to both Oracle databases

## Usage

### 1. Interactive mode (easiest)

```bash
oracle-schema-diff
```

You'll be prompted step-by-step:

```
  oracle-schema-diff — Interactive Setup
  ─────────────────────────────────────

  Source Database (SIT — the one with correct schema):
    User/Schema : TAMWEEL_SIT
    Password    : ********
    Connect URL : 10.0.0.1:1521/SIT

  Target Database (PROD — the one to fix):
    User/Schema : TAMWEEL_PROD
    Password    : ********
    Connect URL : 10.0.0.2:1521/PROD
```

### 2. Config file mode (recommended for teams)

Create a JSON file (e.g. `sit-to-prod.json`):

```json
{
  "sit":  { "user": "TAMWEEL_SIT",  "password": "...", "url": "10.0.0.1:1521/SIT"  },
  "prod": { "user": "TAMWEEL_PROD", "password": "...", "url": "10.0.0.2:1521/PROD" },
  "libDir": "/opt/oracle/instantclient",
  "htmlReportPath": "./schema-report.html"
}
```

> **Important:** Add config files with passwords to `.gitignore` — never commit credentials.

Then run:

```bash
oracle-schema-diff --config sit-to-prod.json
```

### 3. CLI flags mode (good for CI/CD)

```bash
oracle-schema-diff \
  --sit-user  SIT_SCHEMA  --sit-password  secret  --sit-url  10.0.0.1:1521/SIT \
  --prod-user PROD_SCHEMA --prod-password secret  --prod-url 10.0.0.2:1521/PROD \
  --html-report --open-report
```

### 4. Generate visual dashboard

```bash
oracle-schema-diff --config sit-to-prod.json --html-report ./sit-vs-prod.html
```

If you omit the file name, it auto-generates one inside `./output/`:

```bash
oracle-schema-diff --config sit-to-prod.json --html-report
```

Auto-open in default browser:

```bash
oracle-schema-diff --config sit-to-prod.json --html-report --open-report
```

### Additional flags

| Flag | Description |
|------|-------------|
| `--output <file>` | Write SQL to a specific file instead of auto-named |
| `--html-report [file]` | Generate visual HTML report (optional path) |
| `--open-report` | Open generated HTML report automatically |
| `--lib-dir <path>` | Path to Oracle Instant Client libraries |
| `--no-color` | Disable colored output (useful for piping) |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Example Output

### Terminal report

```
══════════════════════════════════════════════════════════════════════════
  SCHEMA DIFF REPORT
  Source : TAMWEEL_SIT
  Target : TAMWEEL_PROD
══════════════════════════════════════════════════════════════════════════

  ✗ Missing Columns (2)
     IDB_WEB_USER.CIF_ID
       In source, missing in target
     IDB_ADDRESS.CITY_NAME
       In source, missing in target

  ✗ Missing Indexes (1)
     IDX_IDB_WEB_USER_CIF_ID
       On IDB_WEB_USER(CIF_ID)

────────────────────────────────────────────────────────────────────────
  SUMMARY
  Total issues : 3
  Critical (need SQL fix) : 3
────────────────────────────────────────────────────────────────────────

  → SQL fix file: diff_TAMWEEL_SIT_to_TAMWEEL_PROD_2026-03-16T10-00-00.sql
```

### Generated SQL file

```sql
-- =================================================================
-- oracle-schema-diff - Auto-generated migration
-- Source : TAMWEEL_SIT
-- Target : TAMWEEL_PROD
-- Generated : 2026-03-16T10:00:00.000Z
--
-- WARNING: REVIEW EVERY STATEMENT BEFORE RUNNING AGAINST PRODUCTION
-- =================================================================

-- [MISSING COLUMN] IDB_WEB_USER.CIF_ID
ALTER TABLE IDB_WEB_USER ADD (CIF_ID NUMBER);

-- [MISSING COLUMN] IDB_ADDRESS.CITY_NAME
ALTER TABLE IDB_ADDRESS ADD (CITY_NAME VARCHAR2(200));

-- [MISSING INDEX] IDX_IDB_WEB_USER_CIF_ID
CREATE INDEX IDX_IDB_WEB_USER_CIF_ID ON IDB_WEB_USER(CIF_ID);

COMMIT;
```

### Generated HTML dashboard includes

- Overall KPI cards (critical issues, warnings, total drift)
- Source vs target schema stats
- Issue-type breakdown chips
- Relationship graph from foreign keys (Mermaid)
- Foreign key relationship table
- Full issue details table

## What it compares

| Object      | Missing in target | Extra in target | Drift/mismatch |
|-------------|:-----------------:|:---------------:|:--------------:|
| Tables      | ✓ (DDL hint)      | ⚠ warning       | —              |
| Columns     | ✓ + ALTER SQL     | ⚠ warning       | ✓ + MODIFY SQL |
| Indexes     | ✓ + CREATE SQL    | ⚠ warning       | ✓ + recreate   |
| Constraints | ✓ (DDL hint)      | ⚠ warning       | —              |
| Sequences   | ✓ + CREATE SQL    | —               | —              |
| Triggers    | ✓ (DDL hint)      | —               | —              |

## Security Notes

- **Never commit** config files containing database passwords
- Add `*.json` config files to `.gitignore` or use a separate ignored directory
- In CI/CD, pass credentials via environment variables or a secrets manager, not CLI flags in logs
- The tool only runs **read-only** SELECT queries against both databases — it never modifies anything

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `ORA-12541: TNS:no listener` | Check connect string and network access |
| `ORA-01017: invalid username/password` | Verify credentials |
| `DPI-1047: Cannot locate Oracle Client library` | Set `--lib-dir` to your Instant Client path |
| Missing objects not showing | Ensure the user has SELECT privileges on ALL_* views |
