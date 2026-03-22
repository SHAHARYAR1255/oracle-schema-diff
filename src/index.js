

const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ─── Color helpers ─────────────────────────────────────────────────────────────

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let useColors = true;
const colorize = (fn, s) => (useColors ? fn(s) : s);

// ─── Oracle metadata queries ──────────────────────────────────────────────────

const QUERIES = {
  tables: `
    SELECT TABLE_NAME
    FROM ALL_TABLES
    WHERE OWNER = :schema
    ORDER BY TABLE_NAME`,

  columns: `
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION,
           DATA_SCALE, NULLABLE, DATA_DEFAULT, COLUMN_ID, CHAR_USED,
           IDENTITY_COLUMN
    FROM ALL_TAB_COLUMNS
    WHERE OWNER = :schema
    ORDER BY TABLE_NAME, COLUMN_ID`,

  indexes: `
    SELECT i.INDEX_NAME, i.TABLE_NAME, i.UNIQUENESS,
           LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS COLUMNS
    FROM ALL_INDEXES i
    JOIN ALL_IND_COLUMNS ic
      ON ic.INDEX_NAME = i.INDEX_NAME AND ic.INDEX_OWNER = i.OWNER
    WHERE i.OWNER = :schema
      AND i.INDEX_TYPE != 'LOB'
    GROUP BY i.INDEX_NAME, i.TABLE_NAME, i.UNIQUENESS
    ORDER BY i.TABLE_NAME, i.INDEX_NAME`,

  constraints: `
    SELECT c.CONSTRAINT_NAME, c.TABLE_NAME, c.CONSTRAINT_TYPE, c.STATUS,
           LISTAGG(cc.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY cc.POSITION) AS COLUMNS
    FROM ALL_CONSTRAINTS c
    LEFT JOIN ALL_CONS_COLUMNS cc
      ON cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.OWNER = c.OWNER
    WHERE c.OWNER = :schema
      AND c.CONSTRAINT_TYPE IN ('P','U','R')
    GROUP BY c.CONSTRAINT_NAME, c.TABLE_NAME, c.CONSTRAINT_TYPE, c.STATUS
    ORDER BY c.TABLE_NAME, c.CONSTRAINT_TYPE, c.CONSTRAINT_NAME`,

  foreignKeys: `
    SELECT c.CONSTRAINT_NAME,
           c.TABLE_NAME,
           rc.TABLE_NAME AS REFERENCED_TABLE,
           LISTAGG(cc.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY cc.POSITION) AS COLUMNS
    FROM ALL_CONSTRAINTS c
    JOIN ALL_CONSTRAINTS rc
      ON rc.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
     AND rc.OWNER = c.OWNER
    LEFT JOIN ALL_CONS_COLUMNS cc
      ON cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
     AND cc.OWNER = c.OWNER
    WHERE c.OWNER = :schema
      AND c.CONSTRAINT_TYPE = 'R'
    GROUP BY c.CONSTRAINT_NAME, c.TABLE_NAME, rc.TABLE_NAME
    ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME`,

  sequences: `
    SELECT SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY,
           CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER
    FROM ALL_SEQUENCES
    WHERE SEQUENCE_OWNER = :schema
    ORDER BY SEQUENCE_NAME`,

  triggers: `
    SELECT TRIGGER_NAME, TABLE_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, STATUS
    FROM ALL_TRIGGERS
    WHERE OWNER = :schema
    ORDER BY TABLE_NAME, TRIGGER_NAME`,
};

// ─── Connection ────────────────────────────────────────────────────────────────

let oracleInitialized = false;

/**
 * Normalize a connect string to Oracle Easy Connect format.
 * Handles JDBC thin URLs: jdbc:oracle:thin:@//host:port/service
 *                     and jdbc:oracle:thin:@host:port:sid
 */
function normalizeConnectString(url) {
  if (!url) return url;
  let s = url.trim();

  // Strip jdbc:oracle:thin:@ prefix (with or without //)
  s = s.replace(/^jdbc:oracle:thin:@\/\//i, '');
  s = s.replace(/^jdbc:oracle:thin:@/i, '');

  // If still has // at start strip it too
  s = s.replace(/^\/\//, '');

  return s;
}

async function connect(creds, label) {
  const connectString = normalizeConnectString(creds.url);
  const conn = await oracledb.getConnection({
    user: creds.user,
    password: creds.password,
    connectString,
  });
  console.log(`  ${colorize(C.green, '\u2713')} Connected to ${colorize(C.bold, label)} ${colorize(C.dim, `(${connectString})`)}`);
  return conn;
}

// ─── Schema fetch ──────────────────────────────────────────────────────────────

async function fetchSchema(conn, schema) {
  const q = (sql) => conn.execute(sql, { schema: schema.toUpperCase() }, { outFormat: oracledb.OUT_FORMAT_OBJECT }).then((r) => r.rows);

  const [tables, columns, indexes, constraints, foreignKeys, sequences, triggers] = await Promise.all([
    q(QUERIES.tables),
    q(QUERIES.columns),
    q(QUERIES.indexes),
    q(QUERIES.constraints),
    q(QUERIES.foreignKeys),
    q(QUERIES.sequences),
    q(QUERIES.triggers),
  ]);

  const columnsByTable = {};
  for (const col of columns) {
    if (!columnsByTable[col.TABLE_NAME]) columnsByTable[col.TABLE_NAME] = {};
    columnsByTable[col.TABLE_NAME][col.COLUMN_NAME] = col;
  }

  return {
    tables: new Set(tables.map((r) => r.TABLE_NAME)),
    columnsByTable,
    indexes: toMap(indexes, 'INDEX_NAME'),
    constraints: toMap(constraints, 'CONSTRAINT_NAME'),
    foreignKeys,
    sequences: toMap(sequences, 'SEQUENCE_NAME'),
    triggers: toMap(triggers, 'TRIGGER_NAME'),
  };
}

function toMap(rows, key) {
  const map = {};
  for (const row of rows) map[row[key]] = row;
  return map;
}

// ─── Column definition builder ─────────────────────────────────────────────────

// Types whose full definition (including precision/scale/length) is already
// embedded in the DATA_TYPE string returned by Oracle, or need no size at all.
const NO_EXPLICIT_SIZE_TYPES = new Set([
  'DATE', 'CLOB', 'NCLOB', 'BLOB', 'BFILE', 'XMLTYPE',
  'ROWID', 'UROWID', 'LONG', 'LONG RAW', 'BINARY_FLOAT', 'BINARY_DOUBLE',
]);

function needsExplicitSize(dataType) {
  if (NO_EXPLICIT_SIZE_TYPES.has(dataType)) return false;
  if (dataType.startsWith('TIMESTAMP')) return false;
  if (dataType.startsWith('INTERVAL')) return false;
  return true;
}

// Build just the type fragment — shared by buildColDef and buildCreateTableDdl.
function buildTypeFragment(col) {
  const dt = col.DATA_TYPE;
  if (!needsExplicitSize(dt)) return dt;
  if ((dt === 'VARCHAR2' || dt === 'CHAR') && col.DATA_LENGTH) {
    const unit = col.CHAR_USED === 'C' ? ' CHAR' : ' BYTE';
    return `${dt}(${col.DATA_LENGTH}${unit})`;
  }
  if ((dt === 'NVARCHAR2' || dt === 'NCHAR') && col.DATA_LENGTH) return `${dt}(${col.DATA_LENGTH})`;
  if (dt === 'RAW' && col.DATA_LENGTH) return `${dt}(${col.DATA_LENGTH})`;
  if (dt === 'NUMBER') {
    if (col.DATA_PRECISION != null) {
      const scale = col.DATA_SCALE != null && col.DATA_SCALE > 0 ? `,${col.DATA_SCALE}` : '';
      return `${dt}(${col.DATA_PRECISION}${scale})`;
    }
    return dt;
  }
  if (dt === 'FLOAT' && col.DATA_PRECISION != null) return `${dt}(${col.DATA_PRECISION})`;
  return dt;
}

// ─── CREATE TABLE DDL builder (for missing tables) ────────────────────────────

function buildCreateTableDdl(tableName, sit, targetSchema) {
  const cols = sit.columnsByTable[tableName] || {};
  const orderedCols = Object.values(cols).sort((a, b) => (a.COLUMN_ID || 0) - (b.COLUMN_ID || 0));

  // Find PK constraint for this table
  const pkCon = Object.values(sit.constraints).find(
    (c) => c.TABLE_NAME === tableName && c.CONSTRAINT_TYPE === 'P'
  );

  const colLines = orderedCols.map((col) => {
    if (col.IDENTITY_COLUMN === 'YES') {
      // Oracle 12c+ identity column — use GENERATED ALWAYS AS IDENTITY
      return `  ${col.COLUMN_NAME} ${buildTypeFragment(col)} GENERATED ALWAYS AS IDENTITY NOT NULL`;
    }
    let line = `  ${col.COLUMN_NAME} ${buildTypeFragment(col)}`;
    if (col.DATA_DEFAULT != null) line += ` DEFAULT ${col.DATA_DEFAULT.trim()}`;
    if (col.NULLABLE === 'N') line += ' NOT NULL';
    return line;
  });

  if (pkCon) {
    colLines.push(`  CONSTRAINT ${pkCon.CONSTRAINT_NAME} PRIMARY KEY (${pkCon.COLUMNS})`);
  }

  return (
    `-- [MISSING TABLE] ${tableName}\n` +
    `CREATE TABLE ${targetSchema}.${tableName} (\n` +
    colLines.join(',\n') + '\n' +
    ');\n'
  );
}

/**
 * Build an Oracle column fragment usable in both ADD and MODIFY.
 * @param {object} col          Row from ALL_TAB_COLUMNS (includes CHAR_USED).
 * @param {object} [opts]
 * @param {boolean} opts.explicitNullable  Emit explicit NULL/NOT NULL (needed for MODIFY).
 */
function buildColDef(col, { explicitNullable = false } = {}) {
  const dt = col.DATA_TYPE;
  let def = col.COLUMN_NAME;

  if (needsExplicitSize(dt)) {
    if ((dt === 'VARCHAR2' || dt === 'CHAR') && col.DATA_LENGTH) {
      // CHAR_USED: 'B' = BYTE semantics, 'C' = CHAR semantics
      const unit = col.CHAR_USED === 'C' ? ' CHAR' : ' BYTE';
      def += ` ${dt}(${col.DATA_LENGTH}${unit})`;
    } else if ((dt === 'NVARCHAR2' || dt === 'NCHAR') && col.DATA_LENGTH) {
      // N-types always use character length in Oracle DDL
      def += ` ${dt}(${col.DATA_LENGTH})`;
    } else if (dt === 'RAW' && col.DATA_LENGTH) {
      def += ` ${dt}(${col.DATA_LENGTH})`;
    } else if (dt === 'NUMBER') {
      if (col.DATA_PRECISION != null) {
        const scale = col.DATA_SCALE != null && col.DATA_SCALE > 0 ? `,${col.DATA_SCALE}` : '';
        def += ` ${dt}(${col.DATA_PRECISION}${scale})`;
      } else {
        def += ` ${dt}`;  // bare NUMBER — no parens
      }
    } else if (dt === 'FLOAT' && col.DATA_PRECISION != null) {
      def += ` ${dt}(${col.DATA_PRECISION})`;
    } else {
      def += ` ${dt}`;
    }
  } else {
    def += ` ${dt}`;
  }

  if (col.IDENTITY_COLUMN !== 'YES' && col.DATA_DEFAULT != null) {
    def += ` DEFAULT ${col.DATA_DEFAULT.trim()}`;
  }

  // For ADD: only emit NOT NULL (NULL is the default, emitting it is noise).
  // For MODIFY: always emit explicitly so Oracle removes/adds the constraint.
  if (explicitNullable) {
    def += col.NULLABLE === 'N' ? ' NOT NULL' : ' NULL';
  } else if (col.NULLABLE === 'N') {
    def += ' NOT NULL';
  }

  return def;
}

// ─── Column diff ───────────────────────────────────────────────────────────────

function columnDiffs(sit, prod) {
  const diffs = [];
  if (sit.DATA_TYPE !== prod.DATA_TYPE) {
    diffs.push(`type: ${prod.DATA_TYPE} -> ${sit.DATA_TYPE}`);
  }
  if (sit.DATA_LENGTH !== prod.DATA_LENGTH) {
    diffs.push(`length: ${prod.DATA_LENGTH} -> ${sit.DATA_LENGTH}`);
  }
  if (sit.DATA_PRECISION !== prod.DATA_PRECISION) {
    diffs.push(`precision: ${prod.DATA_PRECISION} -> ${sit.DATA_PRECISION}`);
  }
  if (sit.DATA_SCALE !== prod.DATA_SCALE) {
    diffs.push(`scale: ${prod.DATA_SCALE} -> ${sit.DATA_SCALE}`);
  }
  if (sit.NULLABLE !== prod.NULLABLE) {
    diffs.push(`nullable: ${prod.NULLABLE} -> ${sit.NULLABLE}`);
  }
  const sitDefault = sit.DATA_DEFAULT ? sit.DATA_DEFAULT.trim() : null;
  const prodDefault = prod.DATA_DEFAULT ? prod.DATA_DEFAULT.trim() : null;
  if (sitDefault !== prodDefault) {
    diffs.push(`default: "${prodDefault || ''}" -> "${sitDefault || ''}"`);
  }
  return diffs;
}

/**
 * Generate inline SQL comment warnings for risky MODIFY operations.
 * Oracle cannot always change a column type when rows exist, and narrowing
 * or adding NOT NULL without existing values causes ORA-errors.
 */
function buildModifyWarnings(sitDef, prodDef, diffs) {
  const lines = [];

  const typeChanged = sitDef.DATA_TYPE !== prodDef.DATA_TYPE;
  const narrowed =
    !typeChanged &&
    sitDef.DATA_LENGTH != null &&
    prodDef.DATA_LENGTH != null &&
    sitDef.DATA_LENGTH < prodDef.DATA_LENGTH;
  const addingNotNull =
    sitDef.NULLABLE === 'N' && prodDef.NULLABLE === 'Y';

  if (typeChanged) {
    lines.push(
      `-- ⚠ WARNING: DATA TYPE CHANGE (${prodDef.DATA_TYPE} -> ${sitDef.DATA_TYPE}).`,
      `--   Oracle will reject this if existing rows cannot be implicitly converted.`,
      `--   Backup the table and verify conversions before applying.`
    );
  }
  if (narrowed) {
    lines.push(
      `-- ⚠ WARNING: COLUMN LENGTH REDUCED (${prodDef.DATA_LENGTH} -> ${sitDef.DATA_LENGTH}).`,
      `--   This will fail (ORA-01401) if any existing value exceeds the new size.`
    );
  }
  if (addingNotNull) {
    lines.push(
      `-- ⚠ WARNING: ADDING NOT NULL constraint.`,
      `--   This will fail (ORA-01758) if any existing row has a NULL value for this column.`,
      `--   Populate NULLs first: UPDATE ${prodDef.TABLE_NAME} SET ${prodDef.COLUMN_NAME} = <value> WHERE ${prodDef.COLUMN_NAME} IS NULL;`
    );
  }

  return lines.length ? lines.join('\n') + '\n' : '';
}

// ─── Main diff engine ──────────────────────────────────────────────────────────

/**
 * @param {object} sit          Fetched source schema data
 * @param {object} prod         Fetched target schema data
 * @param {string} sourceSchema Oracle schema name of source (for DDL comments)
 * @param {string} targetSchema Oracle schema name of target (used in all DDL output)
 * @returns {{ issues, sqls, sqlsByCategory }}
 */
function diffSchemas(sit, prod, sourceSchema, targetSchema) {
  const issues = [];

  // Categorised SQL buckets — ORDER of keys = ORDER in SQL file
  const sqlsByCategory = {
    missingTables: [],
    missingColumns: [],
    columnMismatches: [],
    missingIndexes: [],
    indexMismatches: [],
    missingConstraints: [],
    missingSequences: [],
    missingTriggers: [],
  };

  // Schema-qualify a name for DDL run on the target DB.
  const tgt = (name) => `${targetSchema}.${name}`;

  function addIssue(type, object, detail, bucket, sql) {
    issues.push({ type, object, detail });
    if (sql && bucket) sqlsByCategory[bucket].push(sql);
  }

  // ── Tables ────────────────────────────────────────────────────────────────────
  // Pre-compute fully-missing tables so Columns and Constraints can skip them.
  const missingTableSet = new Set();
  for (const table of sit.tables) {
    if (!prod.tables.has(table)) missingTableSet.add(table);
  }
  for (const table of missingTableSet) {
    addIssue(
      'MISSING_TABLE',
      table,
      'In source, missing in target',
      'missingTables',
      buildCreateTableDdl(table, sit, targetSchema)
    );
  }
  for (const table of prod.tables) {
    if (!sit.tables.has(table)) {
      issues.push({ type: 'EXTRA_TABLE', object: table, detail: 'In target, missing in source — possible orphan or manual change' });
    }
  }

  // ── Columns ───────────────────────────────────────────────────────────────────
  for (const [table, sitCols] of Object.entries(sit.columnsByTable)) {
    if (missingTableSet.has(table)) continue; // already captured by CREATE TABLE DDL
    const prodCols = prod.columnsByTable[table] || {};

    for (const [col, sitDef] of Object.entries(sitCols)) {
      if (!prodCols[col]) {
        addIssue(
          'MISSING_COLUMN',
          `${table}.${col}`,
          'In source, missing in target',
          'missingColumns',
          `-- [MISSING COLUMN] ${table}.${col}\n` +
          `ALTER TABLE ${tgt(table)} ADD (${buildColDef(sitDef)});\n`
        );
      } else {
        const diffs = columnDiffs(sitDef, prodCols[col]);
        if (diffs.length > 0) {
          const warnings = buildModifyWarnings(sitDef, prodCols[col], diffs);
          addIssue(
            'COLUMN_MISMATCH',
            `${table}.${col}`,
            diffs.join(' | '),
            'columnMismatches',
            `${warnings}-- [COLUMN MISMATCH] ${table}.${col} -- ${diffs.join(', ')}\n` +
            `ALTER TABLE ${tgt(table)} MODIFY (${buildColDef(sitDef, { explicitNullable: true })});\n`
          );
        }
      }
    }

    for (const col of Object.keys(prodCols)) {
      if (!sitCols[col]) {
        issues.push({ type: 'EXTRA_COLUMN', object: `${table}.${col}`, detail: 'In target, missing in source' });
      }
    }
  }

  // ── Indexes ───────────────────────────────────────────────────────────────────
  // Some indexes are auto-created by Oracle to back PK / UNIQUE constraints.
  // Those must be recreated via ALTER TABLE ADD CONSTRAINT, not CREATE INDEX.
  const allConstraintNames = new Set([
    ...Object.keys(sit.constraints),
    ...Object.keys(prod.constraints),
  ]);

  for (const [name, sitIdx] of Object.entries(sit.indexes)) {
    if (allConstraintNames.has(name)) continue;

    if (!prod.indexes[name]) {
      const unique = sitIdx.UNIQUENESS === 'UNIQUE' ? 'UNIQUE ' : '';
      addIssue(
        'MISSING_INDEX',
        name,
        `On ${sitIdx.TABLE_NAME}(${sitIdx.COLUMNS})`,
        'missingIndexes',
        `-- [MISSING INDEX] ${name}\n` +
        `CREATE ${unique}INDEX ${tgt(name)} ON ${tgt(sitIdx.TABLE_NAME)}(${sitIdx.COLUMNS});\n`
      );
    } else {
      const prodIdx = prod.indexes[name];
      if (sitIdx.COLUMNS !== prodIdx.COLUMNS || sitIdx.UNIQUENESS !== prodIdx.UNIQUENESS) {
        const unique = sitIdx.UNIQUENESS === 'UNIQUE' ? 'UNIQUE ' : '';
        const detail = sitIdx.COLUMNS !== prodIdx.COLUMNS
          ? `Columns differ: target(${prodIdx.COLUMNS}) -> source(${sitIdx.COLUMNS})`
          : `Uniqueness differs: target(${prodIdx.UNIQUENESS}) -> source(${sitIdx.UNIQUENESS})`;
        addIssue(
          'INDEX_MISMATCH',
          name,
          detail,
          'indexMismatches',
          `-- [INDEX MISMATCH] ${name} -- ${detail}\n` +
          `DROP INDEX ${tgt(name)};\n` +
          `CREATE ${unique}INDEX ${tgt(name)} ON ${tgt(sitIdx.TABLE_NAME)}(${sitIdx.COLUMNS});\n`
        );
      }
    }
  }
  for (const name of Object.keys(prod.indexes)) {
    if (!allConstraintNames.has(name) && !sit.indexes[name]) {
      issues.push({ type: 'EXTRA_INDEX', object: name, detail: `On ${prod.indexes[name].TABLE_NAME} — in target only` });
    }
  }

  // ── Constraints ───────────────────────────────────────────────────────────────
  const constraintTypeLabel = { P: 'PRIMARY KEY', U: 'UNIQUE', R: 'FOREIGN KEY' };
  for (const [name, sitCon] of Object.entries(sit.constraints)) {
    // Skip PK constraints for fully-missing tables — they're embedded in CREATE TABLE DDL
    if (sitCon.CONSTRAINT_TYPE === 'P' && missingTableSet.has(sitCon.TABLE_NAME)) continue;
    if (!prod.constraints[name]) {
      const typeLabel = constraintTypeLabel[sitCon.CONSTRAINT_TYPE] || sitCon.CONSTRAINT_TYPE;
      addIssue(
        'MISSING_CONSTRAINT',
        name,
        `${typeLabel} on ${sitCon.TABLE_NAME}(${sitCon.COLUMNS || 'N/A'})`,
        'missingConstraints',
        `-- [MISSING CONSTRAINT] ${name} (${typeLabel} on ${sitCon.TABLE_NAME})\n` +
        `-- Export full DDL from source and adapt schema name before running:\n` +
        `--   SELECT DBMS_METADATA.GET_DDL('CONSTRAINT','${name}','${sourceSchema}') FROM DUAL;\n`
      );
    }
  }
  for (const name of Object.keys(prod.constraints)) {
    if (!sit.constraints[name]) {
      issues.push({ type: 'EXTRA_CONSTRAINT', object: name, detail: `On ${prod.constraints[name].TABLE_NAME} — in target only` });
    }
  }

  // ── Sequences ─────────────────────────────────────────────────────────────────
  for (const [name, sitSeq] of Object.entries(sit.sequences)) {
    if (!prod.sequences[name]) {
      const startWith = sitSeq.LAST_NUMBER != null ? String(sitSeq.LAST_NUMBER) : '1';
      const maxVal = sitSeq.MAX_VALUE != null ? String(sitSeq.MAX_VALUE) : '9999999999999999999999999999';
      addIssue(
        'MISSING_SEQUENCE',
        name,
        'In source, missing in target',
        'missingSequences',
        `-- [MISSING SEQUENCE] ${name}\n` +
        `CREATE SEQUENCE ${tgt(name)}\n` +
        `  START WITH ${startWith}\n` +
        `  INCREMENT BY ${sitSeq.INCREMENT_BY}\n` +
        `  MINVALUE ${sitSeq.MIN_VALUE}\n` +
        `  MAXVALUE ${maxVal}\n` +
        `  ${sitSeq.CYCLE_FLAG === 'Y' ? 'CYCLE' : 'NOCYCLE'}\n` +
        `  CACHE ${sitSeq.CACHE_SIZE};\n`
      );
    }
  }

  // ── Triggers ──────────────────────────────────────────────────────────────────
  for (const [name, sitTrg] of Object.entries(sit.triggers)) {
    if (!prod.triggers[name]) {
      addIssue(
        'MISSING_TRIGGER',
        name,
        `On ${sitTrg.TABLE_NAME} (${sitTrg.TRIGGERING_EVENT})`,
        'missingTriggers',
        `-- [MISSING TRIGGER] ${name} on ${sitTrg.TABLE_NAME}\n` +
        `-- Export trigger body from source:\n` +
        `--   SELECT DBMS_METADATA.GET_DDL('TRIGGER','${name}','${sourceSchema}') FROM DUAL;\n`
      );
    }
  }

  // Flatten sqls in category order (missing tables first)
  const sqls = Object.values(sqlsByCategory).flat();

  return { issues, sqls, sqlsByCategory };
}

// ─── Terminal Spinner ──────────────────────────────────────────────────────────

class Spinner {
  constructor() {
    this._frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this._idx = 0;
    this._timer = null;
    this._text = '';
  }

  start(text) {
    if (!useColors || !process.stdout.isTTY) {
      process.stdout.write(`  ${text}...\n`);
      return;
    }
    this._text = text;
    this._idx = 0;
    this._timer = setInterval(() => {
      const frame = this._frames[this._idx++ % this._frames.length];
      process.stdout.write(`\r  \x1b[36m${frame}\x1b[0m ${this._text}   `);
    }, 80);
  }

  stop(text) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
    console.log(`  \x1b[32m✔\x1b[0m ${text || this._text}`);
  }

  fail(text) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
    console.log(`  \x1b[31m✘\x1b[0m ${text || this._text}`);
  }
}

// ─── Report printer ────────────────────────────────────────────────────────────

const ISSUE_META = {
  MISSING_TABLE: { color: C.red, icon: '✗', label: 'Missing Tables', severity: 'critical' },
  EXTRA_TABLE: { color: C.yellow, icon: '◌', label: 'Extra Tables (target only)', severity: 'warning' },
  MISSING_COLUMN: { color: C.red, icon: '✗', label: 'Missing Columns', severity: 'critical' },
  EXTRA_COLUMN: { color: C.yellow, icon: '◌', label: 'Extra Columns (target only)', severity: 'warning' },
  COLUMN_MISMATCH: { color: C.magenta, icon: '≠', label: 'Column Mismatches', severity: 'critical' },
  MISSING_INDEX: { color: C.red, icon: '✗', label: 'Missing Indexes', severity: 'critical' },
  EXTRA_INDEX: { color: C.yellow, icon: '◌', label: 'Extra Indexes (target only)', severity: 'warning' },
  INDEX_MISMATCH: { color: C.magenta, icon: '≠', label: 'Index Mismatches', severity: 'critical' },
  MISSING_CONSTRAINT: { color: C.red, icon: '✗', label: 'Missing Constraints', severity: 'critical' },
  EXTRA_CONSTRAINT: { color: C.yellow, icon: '◌', label: 'Extra Constraints', severity: 'warning' },
  MISSING_SEQUENCE: { color: C.red, icon: '✗', label: 'Missing Sequences', severity: 'critical' },
  MISSING_TRIGGER: { color: C.red, icon: '✗', label: 'Missing Triggers', severity: 'critical' },
};

function printReport(issues, sourceLabel, targetLabel) {
  const W = 72;
  const bar = '═'.repeat(W);
  const line = '─'.repeat(W);

  // ── Header box ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(colorize(C.cyan, `╔${'═'.repeat(W)}╗`));
  const title = 'ORACLE SCHEMA DIFF — REPORT';
  const pad = Math.floor((W - title.length) / 2);
  console.log(colorize(C.cyan, `║${' '.repeat(pad)}`) + colorize(C.bold, title) + colorize(C.cyan, `${' '.repeat(W - pad - title.length)}║`));
  console.log(colorize(C.cyan, `╠${'═'.repeat(W)}╣`));
  console.log(colorize(C.cyan, '║') + colorize(C.dim, `  Source : ${sourceLabel.padEnd(W - 2)}`) + colorize(C.cyan, '║'));
  console.log(colorize(C.cyan, '║') + colorize(C.dim, `  Target : ${targetLabel.padEnd(W - 2)}`) + colorize(C.cyan, '║'));
  console.log(colorize(C.cyan, `╚${'═'.repeat(W)}╝`));

  if (issues.length === 0) {
    console.log('');
    console.log(colorize(C.green, `  ✔  Schemas are identical. No changes needed.`));
    console.log('');
    return;
  }

  // ── Group by type ─────────────────────────────────────────────────────────────
  const grouped = {};
  for (const issue of issues) {
    if (!grouped[issue.type]) grouped[issue.type] = [];
    grouped[issue.type].push(issue);
  }

  for (const [type, list] of Object.entries(grouped)) {
    const meta = ISSUE_META[type] || { color: C.cyan, icon: '?', label: type, severity: 'warning' };
    const headerLine = `  ${meta.icon}  ${meta.label}`;
    console.log('');
    console.log(colorize(meta.color, `┌${line}┐`));
    console.log(colorize(meta.color, '│') + colorize(C.bold, headerLine.padEnd(W)) + colorize(meta.color, `│`) + colorize(C.dim, ` (${list.length})`));
    console.log(colorize(meta.color, `└${line}┘`));

    for (const item of list) {
      console.log(`    ${colorize(C.bold, item.object)}`);
      // Wrap long detail lines
      const detail = item.detail || '';
      const chunks = detail.match(/.{1,66}/g) || [detail];
      for (const chunk of chunks) {
        console.log(colorize(C.dim, `      ${chunk}`));
      }
    }
  }

  // ── Summary with mini bar chart ───────────────────────────────────────────────
  const criticalTypes = new Set([
    'MISSING_TABLE', 'MISSING_COLUMN', 'COLUMN_MISMATCH',
    'MISSING_INDEX', 'INDEX_MISMATCH', 'MISSING_CONSTRAINT',
    'MISSING_SEQUENCE', 'MISSING_TRIGGER',
  ]);
  const critical = issues.filter((i) => criticalTypes.has(i.type)).length;
  const warnings = issues.length - critical;

  console.log('');
  console.log(colorize(C.bold, `  ┌${'─'.repeat(W)}┐`));
  console.log(colorize(C.bold, `  │  SUMMARY${' '.repeat(W - 9)}│`));
  console.log(colorize(C.bold, `  ├${'─'.repeat(W)}┤`));

  const barMax = 40;
  const maxCount = Math.max(...Object.values(grouped).map((g) => g.length), 1);
  for (const [type, list] of Object.entries(grouped)) {
    const meta = ISSUE_META[type] || { color: C.cyan, label: type };
    const barLen = Math.max(1, Math.round((list.length / maxCount) * barMax));
    const bar2 = '█'.repeat(barLen);
    const label = meta.label.padEnd(32);
    const count = String(list.length).padStart(4);
    console.log(colorize(C.bold, '  │') + `  ${colorize(meta.color, label + count)}  ${colorize(meta.color, bar2)}` + colorize(C.bold, ''));
  }

  console.log(colorize(C.bold, `  ├${'─'.repeat(W)}┤`));
  console.log(colorize(C.bold, `  │`) + `  Total: ${String(issues.length).padEnd(4)}  ` +
    (critical ? colorize(C.red, `Critical: ${critical}  `) : '') +
    (warnings ? colorize(C.yellow, `Warnings: ${warnings}`) : colorize(C.green, 'No warnings')) +
    colorize(C.bold, ''));
  console.log(colorize(C.bold, `  └${'─'.repeat(W)}┘`));
  console.log('');
}

// ─── SQL file writer ──────────────────────────────────────────────────────────

const SQL_SECTION_ORDER = [
  ['missingTables', '1: MISSING TABLES — Create these tables in the target schema'],
  ['missingColumns', '2: MISSING COLUMNS — Add these columns to existing tables'],
  ['columnMismatches', '3: COLUMN MISMATCHES — Modify column definitions (review warnings!)'],
  ['missingIndexes', '4: MISSING INDEXES — Create these indexes in the target schema'],
  ['indexMismatches', '5: INDEX MISMATCHES — Drop + recreate indexes with different definitions'],
  ['missingConstraints', '6: MISSING CONSTRAINTS — Add these constraints to the target schema'],
  ['missingSequences', '7: MISSING SEQUENCES — Create these sequences in the target schema'],
  ['missingTriggers', '8: MISSING TRIGGERS — Export + create these triggers in the target schema'],
];

function writeSqlFile(sqls, sourceLabel, targetLabel, outputPath, sqlsByCategory) {
  if (!sqls || sqls.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeSrc = sourceLabel.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeTgt = targetLabel.replace(/[^a-zA-Z0-9_]/g, '_');
  const defaultOut = path.join('output', `diff_${safeSrc}_to_${safeTgt}_${timestamp}.sql`);
  const filename = outputPath || defaultOut;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });

  const sep = `-- ${'═'.repeat(67)}`;
  const thin = `-- ${'─'.repeat(67)}`;

  const lines = [
    sep,
    '-- oracle-schema-diff — Auto-generated Migration Script',
    `-- Source  : ${sourceLabel}`,
    `-- Target  : ${targetLabel}`,
    `-- Created : ${new Date().toISOString()}`,
    thin,
    '-- ⚠  REVIEW EVERY STATEMENT BEFORE RUNNING AGAINST ANY PRODUCTION DATABASE',
    '-- ⚠  Run inside a transaction and validate row counts before COMMIT',
    sep,
    '',
  ];

  if (sqlsByCategory) {
    let hasSections = false;
    for (const [bucket, title] of SQL_SECTION_ORDER) {
      const stmts = sqlsByCategory[bucket];
      if (!stmts || stmts.length === 0) continue;
      hasSections = true;
      lines.push('');
      lines.push(sep);
      lines.push(`-- SECTION ${title}`);
      lines.push(sep);
      lines.push('');
      for (const sql of stmts) lines.push(sql);
    }
    if (!hasSections) lines.push(...sqls);
  } else {
    lines.push(...sqls);
  }

  lines.push('');
  lines.push(sep);
  lines.push('-- END OF MIGRATION SCRIPT');
  lines.push(sep);
  lines.push('');
  lines.push('COMMIT;');
  lines.push('');

  fs.writeFileSync(filename, lines.join('\n'), 'utf8');
  return filename;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMermaidGraph(sourceData) {
  const relations = sourceData.foreignKeys || [];
  if (!relations.length) {
    return 'graph LR\n  NoRelationships["No foreign key relationships found"]';
  }

  const maxEdges = 180;
  const selected = relations.slice(0, maxEdges);
  const lines = ['graph LR'];
  for (const fk of selected) {
    const from = fk.TABLE_NAME.replace(/[^A-Za-z0-9_]/g, '_');
    const to = fk.REFERENCED_TABLE.replace(/[^A-Za-z0-9_]/g, '_');
    const label = (fk.COLUMNS || fk.CONSTRAINT_NAME || '').replace(/"/g, '');
    lines.push(`  ${from}[${fk.TABLE_NAME}] -->|${label}| ${to}[${fk.REFERENCED_TABLE}]`);
  }

  return lines.join('\n');
}

function issueStats(issues) {
  const grouped = {};
  for (const issue of issues) {
    if (!grouped[issue.type]) grouped[issue.type] = [];
    grouped[issue.type].push(issue);
  }
  return grouped;
}

// ─── Schema stats helper ──────────────────────────────────────────────────────

function schemaStats(data) {
  const colCount = Object.values(data.columnsByTable).reduce((n, t) => n + Object.keys(t).length, 0);
  return {
    tables: data.tables.size,
    columns: colCount,
    indexes: Object.keys(data.indexes).length,
    constraints: Object.keys(data.constraints).length,
    sequences: Object.keys(data.sequences).length,
    triggers: Object.keys(data.triggers).length,
  };
}

// ─── HTML report (5-tab SPA) ───────────────────────────────────────────────────

function buildSqlByCategory(sqlsByCategory, issues) {
  // Produce categorised SQL blocks for HTML embedding — each entry is
  // { title, bucket, sqls[] }
  const result = [];
  for (const [bucket, title] of SQL_SECTION_ORDER) {
    const stmts = sqlsByCategory[bucket];
    if (stmts && stmts.length > 0) {
      result.push({ bucket, title, sqls: stmts });
    }
  }
  return result;
}

function writeHtmlReport({ sourceLabel, targetLabel, sourceData, targetData,
  issues, reversIssues, sqlsByCategory, reverseSqlsByCategory, sqlFile, htmlReportPath }) {

  const grouped = issueStats(issues);
  const revGrouped = issueStats(reversIssues || []);
  const timestamp = new Date().toISOString();
  const tsShort = timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = path.join('output', `schema_diff_report_${sourceLabel}_to_${targetLabel}_${tsShort}.html`);
  const filename = htmlReportPath || defaultName;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });

  const srcStats = schemaStats(sourceData);
  const tgtStats = schemaStats(targetData);

  const criticalTypes = new Set([
    'MISSING_TABLE', 'MISSING_COLUMN', 'COLUMN_MISMATCH',
    'MISSING_INDEX', 'INDEX_MISMATCH', 'MISSING_CONSTRAINT',
    'MISSING_SEQUENCE', 'MISSING_TRIGGER',
  ]);

  const mermaidSrc = buildMermaidGraph(sourceData);
  const mermaidTgt = buildMermaidGraph(targetData);

  // Serialise data for client-side JS
  const fwdSqlBlocks = buildSqlByCategory(sqlsByCategory || {}, issues);
  const revSqlBlocks = buildSqlByCategory(reverseSqlsByCategory || {}, reversIssues || []);

  // Serialise columnsByTable to a plain object (Set → Array for tables)
  function serializeSchema(data) {
    return {
      tables: Array.from(data.tables),
      columnsByTable: data.columnsByTable,
      foreignKeys: data.foreignKeys || [],
    };
  }

  const DIFF_DATA_JSON = JSON.stringify({
    forward: {
      issues: issues,
      sqlsByCategory: fwdSqlBlocks,
    },
    reverse: {
      issues: reversIssues || [],
      sqlsByCategory: revSqlBlocks,
    },
    sourceLabel,
    targetLabel,
    sourceStats: srcStats,
    targetStats: tgtStats,
    sourceSchema: serializeSchema(sourceData),
    targetSchema: serializeSchema(targetData),
    mermaidForward: mermaidSrc,
    mermaidReverse: mermaidTgt,
    sqlFile: sqlFile || null,
    timestamp,
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Oracle Schema Diff — ${escapeHtml(sourceLabel)} → ${escapeHtml(targetLabel)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css"/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/sql.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
:root{
  --bg:#f0f4f8;--surface:#ffffff;--surface2:#f8fafc;--border:#e2e8f0;
  --ink:#1e293b;--ink2:#475569;--ink3:#94a3b8;
  --accent:#2563eb;--accent-bg:#eff6ff;--accent-border:#bfdbfe;
  --red:#dc2626;--red-bg:#fef2f2;--red-border:#fecaca;
  --yellow:#d97706;--yellow-bg:#fffbeb;--yellow-border:#fde68a;
  --green:#16a34a;--green-bg:#f0fdf4;--green-border:#bbf7d0;
  --purple:#7c3aed;--purple-bg:#f5f3ff;--purple-border:#ddd6fe;
  --radius:10px;--radius-sm:6px;--shadow:0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06);
  --font:'Inter',system-ui,-apple-system,sans-serif;--mono:'JetBrains Mono','Fira Code',monospace;
}
html.dark{
  --bg:#0f172a;--surface:#1e293b;--surface2:#162032;--border:#334155;
  --ink:#f1f5f9;--ink2:#94a3b8;--ink3:#475569;
  --accent:#3b82f6;--accent-bg:#1e3a5f;--accent-border:#1d4ed8;
  --red:#f87171;--red-bg:#450a0a;--red-border:#7f1d1d;
  --yellow:#fbbf24;--yellow-bg:#451a03;--yellow-border:#78350f;
  --green:#4ade80;--green-bg:#052e16;--green-border:#14532d;
  --purple:#a78bfa;--purple-bg:#2e1065;--purple-border:#4c1d95;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--ink);min-height:100vh;line-height:1.55}
a{color:var(--accent);text-decoration:none}

/* ── NAV ── */
.nav{position:sticky;top:0;z-index:100;background:var(--surface);border-bottom:1px solid var(--border);
  box-shadow:0 1px 8px rgba(0,0,0,.06);display:flex;align-items:center;gap:0;padding:0 24px;height:52px}
.nav-brand{font-weight:700;font-size:14px;color:var(--accent);letter-spacing:-.3px;white-space:nowrap;margin-right:20px}
.nav-tabs{display:flex;gap:2px;flex:1}
.nav-tab{background:none;border:none;padding:8px 16px;border-radius:var(--radius-sm);font:inherit;font-size:13px;
  font-weight:500;color:var(--ink2);cursor:pointer;transition:all .15s;white-space:nowrap}
.nav-tab:hover{background:var(--accent-bg);color:var(--accent)}
.nav-tab.active{background:var(--accent-bg);color:var(--accent);font-weight:600}
.nav-actions{display:flex;align-items:center;gap:10px;margin-left:auto}
.dir-toggle{display:flex;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:999px;padding:3px 4px;gap:3px}
.dir-btn{background:none;border:none;padding:4px 12px;border-radius:999px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink2);transition:all .15s}
.dir-btn.active{background:var(--accent);color:#fff;box-shadow:0 1px 4px rgba(37,99,235,.35)}
.theme-btn{background:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 10px;font:inherit;font-size:13px;cursor:pointer;color:var(--ink2);transition:all .15s}
.theme-btn:hover{background:var(--surface2)}

/* ── PANELS ── */
.panel{display:none;padding:28px 32px;max-width:1400px;margin:0 auto}
.panel.active{display:block}

/* ── CARDS & GRIDS ── */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;
  box-shadow:var(--shadow);position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--accent)}
.kpi.red::before{background:var(--red)}.kpi.yellow::before{background:var(--yellow)}.kpi.green::before{background:var(--green)}.kpi.purple::before{background:var(--purple)}
.kpi .k-num{font-size:32px;font-weight:700;line-height:1;margin:4px 0}
.kpi .k-label{font-size:12px;color:var(--ink2);font-weight:500;text-transform:uppercase;letter-spacing:.6px}
.kpi .k-sub{font-size:11px;color:var(--ink3);margin-top:4px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;
  box-shadow:var(--shadow);margin-bottom:20px}
.card h2{font-size:15px;font-weight:600;margin-bottom:16px;color:var(--ink);display:flex;align-items:center;gap:8px}
.card h2 .badge{font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600}

/* ── STACKED BAR ── */
.type-bars{display:flex;flex-direction:column;gap:10px}
.type-bar-row{display:flex;align-items:center;gap:12px;font-size:13px}
.type-bar-row .tb-label{width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2);font-size:12px}
.type-bar-row .tb-track{flex:1;background:var(--surface2);border-radius:999px;height:10px;overflow:hidden}
.type-bar-row .tb-fill{height:100%;border-radius:999px;transition:width .5s}
.type-bar-row .tb-count{width:36px;text-align:right;font-weight:600;font-size:12px;color:var(--ink)}
.fill-red{background:var(--red)}.fill-yellow{background:var(--yellow)}.fill-purple{background:var(--purple)}.fill-green{background:var(--green)}.fill-blue{background:var(--accent)}

/* ── TABLES ── */
.tbl-wrap{overflow-x:auto;border-radius:var(--radius-sm);border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border)}
th{background:var(--surface2);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--ink2);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--accent-bg)}

/* ── BADGES ── */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
.badge-red{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-yellow{background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--yellow-border)}
.badge-purple{background:var(--purple-bg);color:var(--purple);border:1px solid var(--purple-border)}
.badge-blue{background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent-border)}
.badge-green{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}

/* ── SEARCH / FILTERS ── */
.filter-row{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;align-items:center}
.search-box{flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);
  background:var(--surface2);color:var(--ink);font:inherit;font-size:13px}
.search-box:focus{outline:none;border-color:var(--accent)}
.chip{padding:5px 12px;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border);
  background:var(--surface2);color:var(--ink2);transition:all .15s}
.chip.active{border-color:var(--accent);background:var(--accent-bg);color:var(--accent)}
.chip:hover{border-color:var(--accent)}

/* ── SQL VIEWER ── */
.sql-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:18px}
.btn{padding:7px 16px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface2);
  color:var(--ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
.btn:hover{background:var(--accent-bg);color:var(--accent);border-color:var(--accent)}
.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8}
.btn.sm{padding:4px 10px;font-size:11px}
.sql-section{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:14px;overflow:hidden}
.sql-section-header{display:flex;align-items:center;gap:10px;padding:12px 16px;
  background:var(--surface2);cursor:pointer;user-select:none;border-bottom:1px solid var(--border)}
.sql-section-header:hover{background:var(--accent-bg)}
.sql-section-header .sec-title{font-size:13px;font-weight:600;flex:1;color:var(--ink)}
.sql-section-header .sec-count{font-size:11px;color:var(--ink3)}
.collapse-icon{font-size:11px;color:var(--ink3);transition:transform .2s}
.sql-section.collapsed .collapse-icon{transform:rotate(-90deg)}
.sql-section.collapsed .sql-section-body{display:none}
.sql-section-body{position:relative}
.copy-btn-overlay{position:absolute;top:8px;right:10px;z-index:2}
.sql-section-body pre{margin:0!important;border-radius:0!important;max-height:420px;overflow:auto;font-size:12px!important}
.sql-section-body pre code{font-family:var(--mono)!important;font-size:12px!important}
.empty-sql{padding:40px;text-align:center;color:var(--ink3);font-size:14px}

/* ── GRAPH & ZOOM ── */
.graph-controls{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.graph-viewport{overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface2);
  min-height:320px;display:flex;align-items:flex-start;justify-content:flex-start;padding:24px}
.graph-inner{transform-origin:top left;transition:transform .2s}
.mermaid{max-width:100%}

/* ── TABLES TAB ── */
.tab-layout{display:grid;grid-template-columns:260px 1fr;gap:16px;min-height:480px}
.table-list{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  overflow-y:auto;max-height:600px}
.table-list-item{padding:10px 16px;font-size:13px;cursor:pointer;border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:8px;transition:background .1s}
.table-list-item:last-child{border-bottom:none}
.table-list-item:hover{background:var(--accent-bg)}
.table-list-item.selected{background:var(--accent-bg);color:var(--accent);font-weight:600}
.table-detail{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;overflow:auto}
.table-detail h3{font-size:15px;font-weight:600;margin-bottom:14px}
.col-diff-miss{background:var(--red-bg)!important;color:var(--red)}
.col-diff-mismatch{background:var(--yellow-bg)!important;color:var(--yellow)}
.col-extra{background:var(--green-bg)!important;color:var(--green)}

/* ── SCHEMA COMPARISON TABLE ── */
.stat-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat-box{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px 16px}
.stat-box .sb-title{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--ink3);font-weight:600;margin-bottom:10px}
.stat-row{display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-bottom:1px dashed var(--border)}
.stat-row:last-child{border-bottom:none}
.stat-row .sr-v{font-weight:600;color:var(--ink)}

/* ── HERO ── */
.hero{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#1e1b4b 100%);
  color:#fff;border-radius:var(--radius);padding:28px 32px;margin-bottom:24px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;inset:0;background:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")}
.hero-content{position:relative}
.hero h1{font-size:22px;font-weight:700;margin-bottom:6px;letter-spacing:-.4px}
.hero p{font-size:13px;opacity:.8;margin-bottom:18px}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px}
.hero-tag{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);border-radius:999px;
  padding:4px 12px;font-size:12px;font-weight:500}

/* ── EMPTY STATE ── */
.empty{padding:60px 20px;text-align:center;color:var(--ink3)}
.empty .em-icon{font-size:48px;margin-bottom:12px}
.empty .em-title{font-size:16px;font-weight:600;color:var(--ink2);margin-bottom:6px}
.empty .em-sub{font-size:13px}

/* ── RESPONSIVE ─────────────────────────────────────────────────────────────── */
@media(max-width:900px){
  .panel{padding:16px 12px}
  .tab-layout{grid-template-columns:1fr}
  .table-list{max-height:220px}
  .nav{padding:0 12px}
  .kpi .k-num{font-size:24px}
  .kpi-grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .stat-compare{grid-template-columns:1fr}
  .hero{padding:20px 22px}
  .hero h1{font-size:18px}
  .type-bar-row .tb-label{width:160px}
}
@media(max-width:640px){
  /* Top bar row: brand + actions */
  .nav{flex-wrap:wrap;height:auto;padding:0;gap:0}
  .nav-brand{order:1;padding:10px 12px;font-size:13px;margin-right:0}
  .nav-actions{order:2;margin-left:auto;padding:6px 10px;gap:6px;align-items:center;display:flex}
  /* Tabs strip — forced to its own full-width row below the top bar */
  .nav-tabs{order:3;flex-basis:100%;width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;
    scrollbar-width:none;flex-wrap:nowrap;border-top:1px solid var(--border);padding:4px 8px;gap:2px}
  .nav-tabs::-webkit-scrollbar{display:none}
  .nav-tab{padding:8px 14px;font-size:13px;flex-shrink:0;border-radius:6px}
  .dir-toggle{max-width:none}
  .dir-btn{padding:3px 8px;font-size:11px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .panel{padding:12px 10px}
  .kpi-grid{grid-template-columns:1fr 1fr;gap:8px}
  .kpi{padding:12px 12px}
  .kpi .k-num{font-size:20px}
  .kpi .k-label{font-size:11px}
  .card{padding:14px 12px}
  .hero{padding:16px;margin-bottom:14px}
  .hero h1{font-size:15px}
  .hero p{font-size:12px}
  .hero-meta{gap:5px}
  .hero-tag{font-size:11px;padding:3px 8px}
  .filter-row{gap:6px}
  .search-box{font-size:12px;padding:7px 10px}
  .btn{padding:6px 12px;font-size:12px}
  .type-bar-row .tb-label{width:110px;font-size:11px}
  .sql-toolbar{gap:6px}
  table{font-size:12px}
  th,td{padding:7px 8px}
  .graph-viewport{min-height:220px;padding:10px}
}
@media(max-width:380px){
  .nav-brand{display:none}
  .kpi-grid{grid-template-columns:1fr}
  .kpi .k-num{font-size:18px}
}
</style>
</head>
<body>

<nav class="nav">
  <span class="nav-brand">⬡ oracle-schema-diff</span>
  <div class="nav-tabs">
    <button class="nav-tab active" onclick="showTab('overview')">Overview</button>
    <button class="nav-tab" onclick="showTab('issues')">Issues</button>
    <button class="nav-tab" onclick="showTab('sql')">SQL</button>
    <button class="nav-tab" onclick="showTab('graph')">Graph</button>
    <button class="nav-tab" onclick="showTab('tables')">Tables</button>
  </div>
  <div class="nav-actions">
    <div class="dir-toggle" title="Toggle diff direction">
      <button class="dir-btn active" id="btn-fwd" onclick="setDir('forward')">${escapeHtml(sourceLabel)} → ${escapeHtml(targetLabel)}</button>
      <button class="dir-btn" id="btn-rev" onclick="setDir('reverse')">${escapeHtml(targetLabel)} → ${escapeHtml(sourceLabel)}</button>
    </div>
    <button class="theme-btn" id="theme-btn" onclick="toggleTheme()">☾ Dark</button>
  </div>
</nav>

<!-- OVERVIEW -->
<section class="panel active" id="tab-overview">
  <div class="hero hero-content">
    <div class="hero-content">
      <h1>Schema Drift Report</h1>
      <p>Analysing schema differences between <strong>${escapeHtml(sourceLabel)}</strong> and <strong>${escapeHtml(targetLabel)}</strong></p>
      <div class="hero-meta">
        <span class="hero-tag" id="hero-source">Source: ${escapeHtml(sourceLabel)}</span>
        <span class="hero-tag" id="hero-target">Target: ${escapeHtml(targetLabel)}</span>
        <span class="hero-tag">Generated: ${escapeHtml(timestamp.slice(0, 19).replace('T', ' '))}</span>
      </div>
    </div>
  </div>

  <div class="kpi-grid" id="kpi-grid"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
    <div class="card">
      <h2>Issue Breakdown <span class="badge badge-blue" id="total-badge"></span></h2>
      <div class="type-bars" id="type-bars"></div>
    </div>
    <div class="card">
      <h2>Schema Comparison</h2>
      <div class="stat-compare" id="stat-compare"></div>
    </div>
  </div>
</section>

<!-- ISSUES -->
<section class="panel" id="tab-issues">
  <div class="card">
    <h2>All Issues <span class="badge badge-blue" id="issues-total-badge"></span></h2>
    <div class="filter-row">
      <input class="search-box" id="issue-search" placeholder="Search objects, types, details…" oninput="filterIssues()"/>
      <div id="type-chips" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    </div>
    <div class="tbl-wrap">
      <table id="issues-table">
        <thead><tr><th>Type</th><th>Object</th><th>Detail</th></tr></thead>
        <tbody id="issues-tbody"></tbody>
      </table>
    </div>
    <p style="font-size:12px;color:var(--ink3);margin-top:10px" id="issues-count-label"></p>
  </div>
</section>

<!-- SQL -->
<section class="panel" id="tab-sql">
  <div class="card">
    <h2>Migration SQL</h2>
    <div class="sql-toolbar">
      <button class="btn primary" onclick="downloadSql()">⬇ Download All SQL</button>
      <button class="btn" onclick="expandAllSections()">Expand All</button>
      <button class="btn" onclick="collapseAllSections()">Collapse All</button>
      <span style="font-size:12px;color:var(--ink3);margin-left:auto" id="sql-file-label"></span>
    </div>
    <div id="sql-sections"></div>
  </div>
</section>

<!-- GRAPH -->
<section class="panel" id="tab-graph">
  <div class="card">
    <h2>Schema Relationship Graph <span style="font-size:12px;font-weight:400;color:var(--ink3)">(Foreign Keys)</span></h2>
    <div class="graph-controls">
      <button class="btn sm" onclick="graphZoom(0.25)">＋ Zoom In</button>
      <button class="btn sm" onclick="graphZoom(-0.25)">－ Zoom Out</button>
      <button class="btn sm" onclick="graphReset()">↺ Reset</button>
      <span style="font-size:12px;color:var(--ink3)" id="zoom-label">100%</span>
    </div>
    <div class="graph-viewport" id="graph-viewport">
      <div class="graph-inner" id="graph-inner">
        <div class="mermaid" id="mermaid-graph"></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;margin-bottom:0">
      <h2>Foreign Key Details</h2>
      <div class="tbl-wrap"><table id="fk-table">
        <thead><tr><th>Constraint</th><th>Table</th><th>Columns</th><th>Referenced Table</th></tr></thead>
        <tbody id="fk-tbody"></tbody>
      </table></div>
    </div>
  </div>
</section>

<!-- TABLES -->
<section class="panel" id="tab-tables">
  <div class="card" style="padding:0">
    <div class="tab-layout" style="padding:0;gap:0;border-radius:var(--radius)">
      <div>
        <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2)">
          <input class="search-box" id="table-search" placeholder="Filter tables…" oninput="filterTableList()" style="width:100%"/>
        </div>
        <div class="table-list" id="table-list"></div>
      </div>
      <div class="table-detail" id="table-detail">
        <div class="empty">
          <div class="em-icon">📋</div>
          <div class="em-title">Select a table</div>
          <div class="em-sub">Click any table on the left to inspect its columns</div>
        </div>
      </div>
    </div>
  </div>
</section>

<script>
const DIFF_DATA = ${DIFF_DATA_JSON};

// ── State ──────────────────────────────────────────────────────────────────────
let currentDir = 'forward';
let activeTypeFilters = new Set();
let selectedTable = null;
let graphScale = 1;

// ── Theme ──────────────────────────────────────────────────────────────────────
const saved = localStorage.getItem('osd-theme');
if(saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme:dark)').matches)){
  document.documentElement.classList.add('dark');
  document.getElementById('theme-btn').textContent = '☀ Light';
}
function toggleTheme(){
  const isDark = document.documentElement.classList.toggle('dark');
  const btn = document.getElementById('theme-btn');
  btn.textContent = isDark ? '☀ Light' : '☾ Dark';
  localStorage.setItem('osd-theme', isDark ? 'dark' : 'light');
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function showTab(id){
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  event.target.classList.add('active');
  if(id === 'graph') renderGraph();
}

// ── Direction ─────────────────────────────────────────────────────────────────
function setDir(dir){
  currentDir = dir;
  document.getElementById('btn-fwd').classList.toggle('active', dir==='forward');
  document.getElementById('btn-rev').classList.toggle('active', dir==='reverse');
  const src = dir==='forward' ? DIFF_DATA.sourceLabel : DIFF_DATA.targetLabel;
  const tgt = dir==='forward' ? DIFF_DATA.targetLabel : DIFF_DATA.sourceLabel;
  document.getElementById('hero-source').textContent = 'Source: '+src;
  document.getElementById('hero-target').textContent = 'Target: '+tgt;
  renderOverview();
  renderIssuesTable();
  renderSqlSections();
}

// ── Badge color by type ────────────────────────────────────────────────────────
const TYPE_CLASS = {
  MISSING_TABLE:'red', MISSING_COLUMN:'red', MISSING_INDEX:'red',
  MISSING_CONSTRAINT:'red', MISSING_SEQUENCE:'red', MISSING_TRIGGER:'red',
  COLUMN_MISMATCH:'purple', INDEX_MISMATCH:'purple',
  EXTRA_TABLE:'yellow', EXTRA_COLUMN:'yellow', EXTRA_INDEX:'yellow', EXTRA_CONSTRAINT:'yellow',
};
const FILL_CLASS = {
  MISSING_TABLE:'fill-red', MISSING_COLUMN:'fill-red', MISSING_INDEX:'fill-red',
  MISSING_CONSTRAINT:'fill-red', MISSING_SEQUENCE:'fill-red', MISSING_TRIGGER:'fill-red',
  COLUMN_MISMATCH:'fill-purple', INDEX_MISMATCH:'fill-purple',
  EXTRA_TABLE:'fill-yellow', EXTRA_COLUMN:'fill-yellow', EXTRA_INDEX:'fill-yellow', EXTRA_CONSTRAINT:'fill-yellow',
};
function badgeClass(type){ return 'badge-'+(TYPE_CLASS[type]||'blue'); }
function fillClass(type){ return FILL_CLASS[type]||'fill-blue'; }

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Overview ──────────────────────────────────────────────────────────────────
const CRITICAL_TYPES = new Set(['MISSING_TABLE','MISSING_COLUMN','COLUMN_MISMATCH',
  'MISSING_INDEX','INDEX_MISMATCH','MISSING_CONSTRAINT','MISSING_SEQUENCE','MISSING_TRIGGER']);

function renderOverview(){
  const issues = DIFF_DATA[currentDir].issues;
  const critCount = issues.filter(i=>CRITICAL_TYPES.has(i.type)).length;
  const warnCount = issues.length - critCount;
  const src = currentDir==='forward' ? DIFF_DATA.sourceStats : DIFF_DATA.targetStats;
  const tgt = currentDir==='forward' ? DIFF_DATA.targetStats : DIFF_DATA.sourceStats;
  const srcLabel = currentDir==='forward' ? DIFF_DATA.sourceLabel : DIFF_DATA.targetLabel;
  const tgtLabel = currentDir==='forward' ? DIFF_DATA.targetLabel : DIFF_DATA.sourceLabel;

  document.getElementById('kpi-grid').innerHTML = \`
    <div class="kpi"><div class="k-label">Total Issues</div><div class="k-num">\${issues.length}</div><div class="k-sub">\${srcLabel} → \${tgtLabel}</div></div>
    <div class="kpi red"><div class="k-label">Critical</div><div class="k-num" style="color:var(--red)">\${critCount}</div><div class="k-sub">Require SQL fix</div></div>
    <div class="kpi yellow"><div class="k-label">Warnings</div><div class="k-num" style="color:var(--yellow)">\${warnCount}</div><div class="k-sub">Review only</div></div>
    <div class="kpi purple"><div class="k-label">Source Tables</div><div class="k-num" style="color:var(--purple)">\${src.tables}</div><div class="k-sub">\${src.columns} columns</div></div>
    <div class="kpi blue"><div class="k-label">Target Tables</div><div class="k-num" style="color:var(--accent)">\${tgt.tables}</div><div class="k-sub">\${tgt.columns} columns</div></div>
  \`;
  document.getElementById('total-badge').textContent = issues.length;

  // Group
  const grouped = {};
  for(const i of issues){ grouped[i.type]=(grouped[i.type]||[]); grouped[i.type].push(i); }
  const maxCount = Math.max(...Object.values(grouped).map(g=>g.length),1);
  document.getElementById('type-bars').innerHTML = Object.entries(grouped)
    .sort((a,b)=>b[1].length-a[1].length)
    .map(([type,list])=>{
      const pct = Math.round((list.length/maxCount)*100);
      return \`<div class="type-bar-row">
        <span class="tb-label">\${esc(type.replace(/_/g,' '))}</span>
        <div class="tb-track"><div class="tb-fill \${fillClass(type)}" style="width:\${pct}%"></div></div>
        <span class="tb-count">\${list.length}</span>
      </div>\`;
    }).join('') || '<p style="color:var(--ink3);font-size:13px">No issues found — schemas are identical.</p>';

  // Stats comparison
  const statRows = ['tables','columns','indexes','constraints','sequences','triggers'];
  const srcBox = statRows.map(k=>\`<div class="stat-row"><span>\${k}</span><span class="sr-v">\${src[k]}</span></div>\`).join('');
  const tgtBox = statRows.map(k=>\`<div class="stat-row"><span>\${k}</span><span class="sr-v">\${tgt[k]}</span></div>\`).join('');
  document.getElementById('stat-compare').innerHTML = \`
    <div class="stat-box"><div class="sb-title">\${esc(srcLabel)}</div>\${srcBox}</div>
    <div class="stat-box"><div class="sb-title">\${esc(tgtLabel)}</div>\${tgtBox}</div>
  \`;
}

// ── Issues table ──────────────────────────────────────────────────────────────
function renderIssuesTable(){
  const issues = DIFF_DATA[currentDir].issues;
  document.getElementById('issues-total-badge').textContent = issues.length;

  // Build type chip list
  const types = [...new Set(issues.map(i=>i.type))].sort();
  document.getElementById('type-chips').innerHTML = types.map(t=>\`
    <span class="chip \${activeTypeFilters.size===0||activeTypeFilters.has(t)?'active':''}"
      onclick="toggleChip('\${esc(t)}')">\${esc(t.replace(/_/g,' '))}</span>
  \`).join('');

  filterIssues();
}
function toggleChip(type){
  if(activeTypeFilters.has(type)) activeTypeFilters.delete(type);
  else activeTypeFilters.add(type);
  // If none selected = show all
  renderIssuesTable();
}
function filterIssues(){
  const q = (document.getElementById('issue-search').value||'').toLowerCase();
  const issues = DIFF_DATA[currentDir].issues;
  const visible = issues.filter(i=>{
    const typeOk = activeTypeFilters.size===0 || activeTypeFilters.has(i.type);
    const textOk = !q || i.type.toLowerCase().includes(q) || i.object.toLowerCase().includes(q) || (i.detail||'').toLowerCase().includes(q);
    return typeOk && textOk;
  });
  document.getElementById('issues-tbody').innerHTML = visible.map(i=>\`
    <tr><td><span class="badge \${badgeClass(i.type)}">\${esc(i.type)}</span></td>
        <td style="font-family:var(--mono);font-size:12px">\${esc(i.object)}</td>
        <td style="color:var(--ink2);font-size:12px">\${esc(i.detail)}</td></tr>
  \`).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--ink3);padding:30px">No matching issues.</td></tr>';
  document.getElementById('issues-count-label').textContent = \`Showing \${visible.length} of \${issues.length} issues\`;
}

// ── SQL sections ──────────────────────────────────────────────────────────────
function renderSqlSections(){
  const blocks = DIFF_DATA[currentDir].sqlsByCategory;
  const sqlFile = DIFF_DATA.sqlFile;
  const lbl = document.getElementById('sql-file-label');
  lbl.textContent = sqlFile ? 'Generated file: '+sqlFile : '';

  const container = document.getElementById('sql-sections');
  if(!blocks || blocks.length===0){
    container.innerHTML = '<div class="empty-sql">No SQL changes needed — schemas are identical.</div>';
    return;
  }
  container.innerHTML = blocks.map((block,idx)=>{
    const code = block.sqls.join('\\n');
    const safeCode = esc(code);
    return \`<div class="sql-section" id="sqlsec-\${idx}">
      <div class="sql-section-header" onclick="toggleSection(\${idx})">
        <span class="collapse-icon">▼</span>
        <span class="sec-title">\${esc(block.title)}</span>
        <span class="sec-count">\${block.sqls.length} statement\${block.sqls.length!==1?'s':''}</span>
      </div>
      <div class="sql-section-body">
        <div class="copy-btn-overlay">
          <button class="btn sm" onclick="copySqlSection(\${idx},event)">⎘ Copy</button>
        </div>
        <pre><code class="language-sql">\${safeCode}</code></pre>
      </div>
    </div>\`;
  }).join('');

  // highlight.js
  container.querySelectorAll('pre code').forEach(el=>hljs.highlightElement(el));
}
function toggleSection(idx){
  document.getElementById('sqlsec-'+idx).classList.toggle('collapsed');
}
function expandAllSections(){ document.querySelectorAll('.sql-section').forEach(s=>s.classList.remove('collapsed')); }
function collapseAllSections(){ document.querySelectorAll('.sql-section').forEach(s=>s.classList.add('collapsed')); }
function copySqlSection(idx,e){
  e.stopPropagation();
  const pre = document.querySelector('#sqlsec-'+idx+' pre code');
  navigator.clipboard.writeText(pre.textContent).then(()=>{
    const btn = e.target; btn.textContent='✔ Copied'; setTimeout(()=>btn.textContent='⎘ Copy',2000);
  });
}
function downloadSql(){
  const blocks = DIFF_DATA[currentDir].sqlsByCategory;
  if(!blocks||blocks.length===0) return alert('No SQL to download.');
  const lines = [];
  const eq = '-- '+'═'.repeat(65);
  lines.push(eq, '-- oracle-schema-diff — Migration Script', \`-- Direction: \${DIFF_DATA.sourceLabel} → \${DIFF_DATA.targetLabel}\`, \`-- Generated: \${DIFF_DATA.timestamp}\`, eq, '');
  for(const block of blocks){
    lines.push(eq, \`-- SECTION \${block.title}\`, eq, '');
    lines.push(...block.sqls, '');
  }
  lines.push(eq, '-- END OF MIGRATION SCRIPT', eq, '', 'COMMIT;', '');
  const blob = new Blob([lines.join('\\n')], {type:'text/plain'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = \`diff_\${currentDir}_\${Date.now()}.sql\`; a.click();
}

// ── Graph ─────────────────────────────────────────────────────────────────────
let graphRendered = false;
function renderGraph(){
  if(graphRendered) return; graphRendered = true;
  const gd = currentDir==='forward' ? DIFF_DATA.mermaidForward : DIFF_DATA.mermaidReverse;
  const el = document.getElementById('mermaid-graph');
  el.textContent = gd;
  el.removeAttribute('data-processed');
  mermaid.init(undefined, el);

  // FK table
  const fks = (currentDir==='forward' ? DIFF_DATA.sourceSchema : DIFF_DATA.targetSchema).foreignKeys || [];
  document.getElementById('fk-tbody').innerHTML = fks.slice(0,300).map(fk=>\`
    <tr><td style="font-family:var(--mono);font-size:12px">\${esc(fk.CONSTRAINT_NAME)}</td>
        <td>\${esc(fk.TABLE_NAME)}</td><td style="font-family:var(--mono);font-size:12px">\${esc(fk.COLUMNS)}</td>
        <td>\${esc(fk.REFERENCED_TABLE)}</td></tr>
  \`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--ink3);padding:20px">No foreign keys found.</td></tr>';
}
function graphZoom(delta){
  graphScale = Math.min(4,Math.max(0.25,graphScale+delta));
  document.getElementById('graph-inner').style.transform = \`scale(\${graphScale})\`;
  document.getElementById('zoom-label').textContent = Math.round(graphScale*100)+'%';
}
function graphReset(){ graphScale=1; document.getElementById('graph-inner').style.transform='scale(1)'; document.getElementById('zoom-label').textContent='100%'; }

// ── Tables tab ────────────────────────────────────────────────────────────────
function buildTableList(){
  const srcTables = new Set(DIFF_DATA.sourceSchema.tables);
  const tgtTables = new Set(DIFF_DATA.targetSchema.tables);
  const allTables = [...new Set([...srcTables,...tgtTables])].sort();

  const container = document.getElementById('table-list');
  container.innerHTML = allTables.map(t=>{
    const inSrc = srcTables.has(t), inTgt = tgtTables.has(t);
    const dot = !inTgt ? '🔴' : !inSrc ? '🟡' : '🟢';
    return \`<div class="table-list-item" data-table="\${esc(t)}" onclick="selectTable('\${esc(t)}')">\${dot} \${esc(t)}</div>\`;
  }).join('');
}
function filterTableList(){
  const q = (document.getElementById('table-search').value||'').toLowerCase();
  document.querySelectorAll('#table-list .table-list-item').forEach(el=>{
    el.style.display = el.dataset.table.toLowerCase().includes(q) ? '' : 'none';
  });
}
function selectTable(tableName){
  selectedTable = tableName;
  document.querySelectorAll('#table-list .table-list-item').forEach(el=>el.classList.toggle('selected',el.dataset.table===tableName));

  const srcCols = (DIFF_DATA.sourceSchema.columnsByTable||{})[tableName]||{};
  const tgtCols = (DIFF_DATA.targetSchema.columnsByTable||{})[tableName]||{};
  const allCols = [...new Set([...Object.keys(srcCols),...Object.keys(tgtCols)])];

  const inSrc = DIFF_DATA.sourceSchema.tables.includes(tableName);
  const inTgt = DIFF_DATA.targetSchema.tables.includes(tableName);

  // Build mismatches set from issues
  const mismatches = new Set(DIFF_DATA[currentDir].issues
    .filter(i=>i.object.startsWith(tableName+'.')||(i.type==='COLUMN_MISMATCH'&&i.object.split('.')[0]===tableName))
    .map(i=>i.object.split('.')[1])
  );
  const missingInTgt = new Set(DIFF_DATA[currentDir].issues
    .filter(i=>i.type==='MISSING_COLUMN'&&i.object.split('.')[0]===tableName)
    .map(i=>i.object.split('.')[1])
  );

  const detail = document.getElementById('table-detail');
  detail.innerHTML = \`<h3>
    \${esc(tableName)}
    \${inSrc?'<span class="badge badge-blue">source</span>':'<span class="badge badge-yellow">source⛔</span>'}
    \${inTgt?'<span class="badge badge-green">target</span>':'<span class="badge badge-red">target⛔</span>'}
  </h3>
  <div class="tbl-wrap">
  <table>
    <thead><tr><th>Column</th><th>Source Type</th><th>Target Type</th><th>Nullable (src)</th><th>Status</th></tr></thead>
    <tbody>
    \${allCols.map(col=>{
      const sc = srcCols[col], tc = tgtCols[col];
      const missing = !tc && sc;
      const extra   = tc && !sc;
      const mismatch = sc && tc && mismatches.has(col);
      const rowClass = missing ? 'col-diff-miss' : extra ? 'col-extra' : mismatch ? 'col-diff-mismatch' : '';
      const status   = missing?'⛔ Missing in target': extra?'➕ Extra in target': mismatch?'≠ Mismatch':'✓ OK';
      return \`<tr class="\${rowClass}">
        <td style="font-family:var(--mono);font-size:12px"><strong>\${esc(col)}</strong></td>
        <td style="font-family:var(--mono);font-size:12px">\${sc?esc(sc.DATA_TYPE+(sc.DATA_LENGTH?' ('+sc.DATA_LENGTH+')':'')):'—'}</td>
        <td style="font-family:var(--mono);font-size:12px">\${tc?esc(tc.DATA_TYPE+(tc.DATA_LENGTH?' ('+tc.DATA_LENGTH+')':'')):'—'}</td>
        <td>\${sc?esc(sc.NULLABLE):'—'}</td>
        <td style="font-weight:600">\${status}</td>
      </tr>\`;
    }).join('')}
    </tbody>
  </table></div>\`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', maxTextSize: 100000, theme: 'neutral' });
hljs.configure({ languages: ['sql'] });

renderOverview();
renderIssuesTable();
renderSqlSections();
buildTableList();
</script>
</body>
</html>`;

  fs.writeFileSync(filename, html, 'utf8');
  return filename;
}

function openInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  const quoted = `"${absolutePath}"`;
  let cmd;

  if (process.platform === 'win32') cmd = `start "" ${quoted}`;
  else if (process.platform === 'darwin') cmd = `open ${quoted}`;
  else cmd = `xdg-open ${quoted}`;

  exec(cmd, (error) => {
    if (error) {
      console.log(colorize(C.yellow, `  Could not auto-open report. Open manually: ${absolutePath}`));
    }
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function run(config) {
  useColors = config.colors !== false;

  oracledb.autoCommit = false;
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

  if (config.libDir && !oracleInitialized) {
    await oracledb.initOracleClient({ libDir: config.libDir });
    oracleInitialized = true;
  }

  const spinner = new Spinner();
  let sitConn;
  let prodConn;

  // ── Banner ────────────────────────────────────────────────────────────────────
  const W = 60;
  console.log('');
  console.log(colorize(C.cyan, `╔${'═'.repeat(W)}╗`));
  console.log(colorize(C.cyan, '║') + colorize(C.bold, '  oracle-schema-diff'.padEnd(W)) + colorize(C.cyan, '║'));
  console.log(colorize(C.cyan, `╚${'═'.repeat(W)}╝`));
  console.log('');

  try {
    // ── Connect ────────────────────────────────────────────────────────────────
    spinner.start('Connecting to databases…');
    [sitConn, prodConn] = await Promise.all([
      connect(config.sit, 'Source'),
      connect(config.prod, 'Target'),
    ]);
    spinner.stop('Connected to both databases');

    const sourceSchema = config.sit.user.toUpperCase();
    const targetSchema = config.prod.user.toUpperCase();

    // ── Fetch ──────────────────────────────────────────────────────────────────
    spinner.start('Fetching schema metadata…');
    const [sourceData, targetData] = await Promise.all([
      fetchSchema(sitConn, sourceSchema),
      fetchSchema(prodConn, targetSchema),
    ]);
    spinner.stop('Schema metadata fetched');

    const srcSt = schemaStats(sourceData);
    const tgtSt = schemaStats(targetData);
    console.log(colorize(C.dim, `  Source (${sourceSchema}): ${srcSt.tables} tables, ${srcSt.columns} columns, ${srcSt.sequences} sequences`));
    console.log(colorize(C.dim, `  Target (${targetSchema}): ${tgtSt.tables} tables, ${tgtSt.columns} columns, ${tgtSt.sequences} sequences`));
    console.log('');

    // ── Diff ───────────────────────────────────────────────────────────────────
    spinner.start('Computing diff…');
    const { issues, sqls, sqlsByCategory } = diffSchemas(sourceData, targetData, sourceSchema, targetSchema);
    // Reverse diff for direction toggle in HTML
    const { issues: reversIssues, sqlsByCategory: reverseSqlsByCategory } =
      diffSchemas(targetData, sourceData, targetSchema, sourceSchema);
    spinner.stop(`Diff complete — ${issues.length} issue${issues.length !== 1 ? 's' : ''} found`);

    let sqlFile = null;

    printReport(issues, sourceSchema, targetSchema);

    if (sqls.length > 0) {
      sqlFile = writeSqlFile(sqls, sourceSchema, targetSchema, config.output, sqlsByCategory);
      console.log(`  ${colorize(C.cyan, '→')} SQL file : ${colorize(C.bold, sqlFile)}`);
      console.log(colorize(C.yellow, '  ⚠  Review every statement before running against any production DB.\n'));
    }

    if (config.htmlReport || config.openReport) {
      const htmlFile = writeHtmlReport({
        sourceLabel: sourceSchema,
        targetLabel: targetSchema,
        sourceData,
        targetData,
        issues,
        reversIssues,
        sqlsByCategory,
        reverseSqlsByCategory,
        sqlFile,
        htmlReportPath: config.htmlReportPath,
      });
      console.log(`  ${colorize(C.cyan, '→')} HTML report: ${colorize(C.bold, htmlFile)}`);
      if (config.openReport) openInBrowser(htmlFile);
    }

    return { issues, sqls, sqlFile };
  } finally {
    if (sitConn) await sitConn.close().catch(() => { });
    if (prodConn) await prodConn.close().catch(() => { });
  }
}

module.exports = { run };

