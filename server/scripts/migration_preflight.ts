import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { env, sanitizeDatabaseUrl, extractDatabaseName } from '../src/config/env';

export const EXPECTED_APPLICATION_TABLES = [
  'User',
  'Collection',
  'Movie',
  'CollectionMovie',
  'UserMovieWatchStatus',
  'CollectionMember',
  'CollaborationInvitation',
  'Session',
] as const;

export type DatabaseState = 'EMPTY' | 'VALID' | 'PARTIAL' | 'INCONSISTENT' | 'PARTIAL_OR_INCONSISTENT';

export interface ConflictReport {
  category: string;
  count: number;
  details: unknown[];
  resolutionHint: string;
}

export interface PreflightResult {
  success: boolean;
  state: DatabaseState;
  databaseName: string;
  conflicts: ConflictReport[];
  error?: string;
}

export interface DiskMigration {
  name: string;
  dirPath: string;
  sqlPath: string;
  sqlContent: string;
  checksum: string; // SHA-256
}

export interface PreflightOptions {
  migrationsDir?: string;
}

export function getValidatedDiskMigrations(customMigrationsDir?: string): DiskMigration[] {
  const migrationsDir = customMigrationsDir || path.resolve(__dirname, '../prisma/migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Prisma migrations directory does not exist at "${migrationsDir}".`);
  }
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const dirEntries = entries.filter((e) => e.isDirectory());
  if (dirEntries.length === 0) {
    throw new Error(`Prisma migrations directory at "${migrationsDir}" contains zero migration directories.`);
  }

  const diskMigrations: DiskMigration[] = [];
  const seenNames = new Set<string>();

  for (const dir of dirEntries) {
    const dirPath = path.join(migrationsDir, dir.name);
    const sqlPath = path.join(dirPath, 'migration.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migration directory "${dir.name}" is missing required migration.sql file.`);
    }
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    if (!sqlContent || sqlContent.trim().length === 0) {
      throw new Error(`Migration SQL file in "${dir.name}" is empty.`);
    }
    if (seenNames.has(dir.name)) {
      throw new Error(`Duplicate migration directory name detected: "${dir.name}".`);
    }
    seenNames.add(dir.name);

    const checksum = crypto.createHash('sha256').update(sqlContent).digest('hex');
    diskMigrations.push({
      name: dir.name,
      dirPath,
      sqlPath,
      sqlContent,
      checksum,
    });
  }

  return diskMigrations.sort((a, b) => a.name.localeCompare(b.name));
}

export function getDiskMigrations(customMigrationsDir?: string): string[] {
  return getValidatedDiskMigrations(customMigrationsDir).map((m) => m.name);
}

function stripOuterParentheses(s: string): string {
  let str = s.trim();
  while (str.startsWith('(') && str.endsWith(')')) {
    let depth = 0;
    let matchedEnd = false;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') depth--;
      if (depth === 0) {
        matchedEnd = i === str.length - 1;
        break;
      }
    }
    if (matchedEnd) {
      str = str.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return str;
}

function splitByTopLevelOperator(expr: string, op: 'OR' | 'AND'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  const trimmed = expr.trim();
  const opStr = ` ${op} `;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];

    if ((ch === '"' || ch === "'") && (i === 0 || trimmed[i - 1] !== '\\')) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = ch;
      } else if (quoteChar === ch) {
        inQuotes = false;
        quoteChar = '';
      }
      current += ch;
      i++;
      continue;
    }

    if (!inQuotes) {
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      } else if (depth === 0) {
        const sub = trimmed.substring(i, i + opStr.length);
        if (sub.toUpperCase() === opStr) {
          parts.push(current.trim());
          current = '';
          i += opStr.length;
          continue;
        }
      }
    }

    current += ch;
    i++;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

function normalizeConjunct(s: string): string {
  return s
    .toLowerCase()
    .replace(/::"?watchstatus"?/g, '')
    .replace(/["'\s()]/g, '');
}

/**
 * Semantically validates the watched-status check constraint definition.
 * Strictly verifies the canonical invariant:
 * (("status" = 'WATCHED'::"WatchStatus" AND "watchedAt" IS NOT NULL) OR
 *  ("status" = 'TO_WATCH'::"WatchStatus" AND "watchedAt" IS NULL))
 *
 * Rejects:
 * - Loose conditions or extra permissive clauses (e.g. OR TRUE, OR 1=1).
 * - Definitions missing either branch.
 * - Inverted nullability semantics.
 * - Any conjuncts other than the exact canonical watched and unwatched rules.
 */
export function validateWatchedStatusCheckConstraint(def: string): boolean {
  if (!def || typeof def !== 'string') return false;
  let cleaned = def.trim();
  if (cleaned.toUpperCase().startsWith('CHECK')) {
    cleaned = cleaned.slice(5).trim();
  }
  cleaned = stripOuterParentheses(cleaned);

  const orBranches = splitByTopLevelOperator(cleaned, 'OR');
  if (orBranches.length !== 2) {
    return false;
  }

  let hasWatchedBranch = false;
  let hasToWatchBranch = false;

  for (const branch of orBranches) {
    const strippedBranch = stripOuterParentheses(branch);
    const andConjuncts = splitByTopLevelOperator(strippedBranch, 'AND');
    if (andConjuncts.length !== 2) {
      return false;
    }

    const normConjuncts = andConjuncts.map(normalizeConjunct);

    const isWatchedStatus = normConjuncts.includes('status=watched');
    const isWatchedNotNull = normConjuncts.includes('watchedatisnotnull');

    const isToWatchStatus = normConjuncts.includes('status=to_watch');
    const isWatchedNull = normConjuncts.includes('watchedatisnull');

    if (isWatchedStatus && isWatchedNotNull) {
      hasWatchedBranch = true;
    } else if (isToWatchStatus && isWatchedNull) {
      hasToWatchBranch = true;
    } else {
      return false;
    }
  }

  return hasWatchedBranch && hasToWatchBranch;
}

export async function runMigrationPreflight(
  targetPoolOrUrl?: Pool | string,
  options?: PreflightOptions
): Promise<PreflightResult> {
  let pool: Pool;
  let shouldClosePool = false;

  if (targetPoolOrUrl instanceof Pool) {
    pool = targetPoolOrUrl;
  } else if (typeof targetPoolOrUrl === 'string') {
    pool = new Pool({ connectionString: targetPoolOrUrl, max: 2, connectionTimeoutMillis: 5000 });
    shouldClosePool = true;
  } else {
    // Migration preflight default: prioritize explicit TARGET_DATABASE_URL CLI parameter,
    // otherwise fallback to appropriate database URL for the environment.
    const connectionString =
      process.env.TARGET_DATABASE_URL ||
      (env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL);
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
    shouldClosePool = true;
  }

  let client: PoolClient | null = null;
  const conflicts: ConflictReport[] = [];

  try {
    client = await pool.connect();

    // 1. Verify and log database identity
    const dbIdentityRes = await client.query('SELECT current_database() AS db_name, current_user AS user_name;');
    const currentDb = dbIdentityRes.rows[0]?.db_name || 'unknown';
    console.log(`🔍 Inspecting target database: "${currentDb}"`);

    // 2. Discover existing tables in 'public' schema
    const tableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);
    const allTables = new Set(tableRes.rows.map((r: { table_name: string }) => r.table_name));
    const existingAppTables = EXPECTED_APPLICATION_TABLES.filter((t) => allTables.has(t));
    const hasMigrationsTable = allTables.has('_prisma_migrations');

    const unrelatedTables = Array.from(allTables).filter(
      (t) => !EXPECTED_APPLICATION_TABLES.includes(t as any) && t !== '_prisma_migrations'
    );

    // 3. Validate disk migrations upfront
    let diskMigrations: DiskMigration[] = [];
    try {
      diskMigrations = getValidatedDiskMigrations(options?.migrationsDir);
    } catch (diskErr: any) {
      conflicts.push({
        category: 'Invalid or Missing Disk Migrations',
        count: 1,
        details: [{ error: diskErr.message }],
        resolutionHint: 'Ensure prisma/migrations directory exists and contains valid migration directories with migration.sql.',
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: diskErr.message,
      };
    }

    // 4. Strict State Classification
    // Case A: Truly empty database (0 tables in public schema)
    if (allTables.size === 0) {
      const viewRes = await client.query(`
        SELECT table_name FROM information_schema.views WHERE table_schema = 'public';
      `);
      const views = viewRes.rows.map((r: { table_name: string }) => r.table_name);

      const matviewRes = await client.query(`
        SELECT matviewname FROM pg_matviews WHERE schemaname = 'public';
      `);
      const matviews = matviewRes.rows.map((r: { matviewname: string }) => r.matviewname);

      const seqRes = await client.query(`
        SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public';
      `);
      const sequences = seqRes.rows.map((r: { sequence_name: string }) => r.sequence_name);

      const typeRes = await client.query(`
        SELECT typname FROM pg_type t 
        JOIN pg_namespace n ON t.typnamespace = n.oid 
        WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c');
      `);
      const customTypes = typeRes.rows.map((r: { typname: string }) => r.typname);

      const routineRes = await client.query(`
        SELECT routine_name FROM information_schema.routines 
        WHERE routine_schema = 'public';
      `);
      const routines = routineRes.rows.map((r: { routine_name: string }) => r.routine_name);

      const leftoverArtifacts: string[] = [];
      if (views.length > 0) leftoverArtifacts.push(`views: ${views.join(', ')}`);
      if (matviews.length > 0) leftoverArtifacts.push(`materialized views: ${matviews.join(', ')}`);
      if (sequences.length > 0) leftoverArtifacts.push(`sequences: ${sequences.join(', ')}`);
      if (customTypes.length > 0) leftoverArtifacts.push(`types: ${customTypes.join(', ')}`);
      if (routines.length > 0) leftoverArtifacts.push(`routines: ${routines.join(', ')}`);

      if (leftoverArtifacts.length > 0) {
        const category = views.length > 0
          ? 'Leftover Views in Target Database'
          : 'Leftover Database Artifacts in Schema';
        conflicts.push({
          category,
          count: leftoverArtifacts.length,
          details: [{
            views,
            materializedViews: matviews,
            sequences,
            types: customTypes,
            routines,
          }],
          resolutionHint: `Target database contains leftover artifacts (${leftoverArtifacts.join('; ')}). Drop leftover objects or clean public schema before initial migration.`,
        });
        return {
          success: false,
          state: 'INCONSISTENT',
          databaseName: currentDb,
          conflicts,
          error: `Database has no tables but contains leftover objects: ${leftoverArtifacts.join('; ')}`,
        };
      }
      console.log('ℹ️ Preflight notice: Truly empty database detected (0 tables, 0 views, 0 materialized views, 0 sequences, 0 types, 0 routines). Clean for initial migration.');
      return {
        success: true,
        state: 'EMPTY',
        databaseName: currentDb,
        conflicts: [],
      };
    }

    // Case B: Unrelated tables exist and 0 CineTrack application tables exist
    if (existingAppTables.length === 0 && unrelatedTables.length > 0) {
      conflicts.push({
        category: 'Unrelated User Tables in Schema',
        count: unrelatedTables.length,
        details: [{ unrelatedTables }],
        resolutionHint:
          `Database is not clean for migration. It contains ${unrelatedTables.length} unrelated table(s): ${unrelatedTables.join(', ')}. Target an empty database.`,
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: `Database contains unrelated tables (${unrelatedTables.join(', ')}); not clean for initial migration.`,
      };
    }

    // Case C: Inconsistent migration history without application tables
    if (existingAppTables.length === 0 && hasMigrationsTable) {
      conflicts.push({
        category: 'Inconsistent Migration History',
        count: 1,
        details: [{ message: 'Database has _prisma_migrations table but 0 CineTrack application tables.' }],
        resolutionHint:
          'Database contains _prisma_migrations history but 0 application tables. Reset migration metadata: DROP TABLE IF EXISTS "_prisma_migrations";',
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: 'Database has migration records but zero application tables.',
      };
    }

    // Case D: Partial application schema (some tables exist, but not all 7)
    if (existingAppTables.length > 0 && existingAppTables.length < EXPECTED_APPLICATION_TABLES.length) {
      const missingTables = EXPECTED_APPLICATION_TABLES.filter((t) => !allTables.has(t));
      conflicts.push({
        category: 'Partial Application Schema Detected',
        count: missingTables.length,
        details: [{ existingAppTables, missingTables }],
        resolutionHint:
          `Database contains a partially initialized schema. Missing tables: ${missingTables.join(', ')}. Run manual remediation or inspect migration state.`,
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: `Partially initialized schema: ${missingTables.length} required application tables missing.`,
      };
    }

    // Case E: Unrelated tables exist alongside application tables
    if (unrelatedTables.length > 0) {
      conflicts.push({
        category: 'Unexpected/Unrelated Tables Detected in Schema',
        count: unrelatedTables.length,
        details: [{ unrelatedTables }],
        resolutionHint:
          `Database contains unexpected table(s) alongside application tables: ${unrelatedTables.join(', ')}. Verify schema isolation.`,
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: `Database contains unexpected/unrelated tables: ${unrelatedTables.join(', ')}`,
      };
    }

    // Case F: Application tables exist but _prisma_migrations is missing
    if (!hasMigrationsTable) {
      conflicts.push({
        category: 'Missing Prisma Migration Metadata Table',
        count: 1,
        details: [{ message: 'All application tables exist but _prisma_migrations table is missing' }],
        resolutionHint:
          'Application tables exist without _prisma_migrations. Baseline the migration state using: npx prisma migrate resolve --applied <migration_name>',
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Application tables exist without _prisma_migrations history table.',
      };
    }

    // 5. Inspect _prisma_migrations details
    const migRes = await client.query(`
      SELECT id, checksum, migration_name, finished_at, rolled_back_at, applied_steps_count
      FROM "_prisma_migrations"
      ORDER BY started_at ASC;
    `);

    // Check for duplicate migration history rows
    const duplicateMigRes = await client.query(`
      SELECT migration_name, count(*) AS count
      FROM "_prisma_migrations"
      GROUP BY migration_name
      HAVING count(*) > 1;
    `);
    if (duplicateMigRes.rows.length > 0) {
      conflicts.push({
        category: 'Duplicate Migration History Records',
        count: duplicateMigRes.rows.length,
        details: duplicateMigRes.rows,
        resolutionHint: 'Resolve duplicate rows in _prisma_migrations table.',
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: 'Duplicate migration records detected in _prisma_migrations.',
      };
    }

    const appliedRows = migRes.rows.filter((r) => r.finished_at && !r.rolled_back_at);
    const failedRows = migRes.rows.filter((r) => !r.finished_at || r.rolled_back_at);
    const incompleteStepRows = migRes.rows.filter((r) => r.applied_steps_count < 1);

    if (failedRows.length > 0) {
      conflicts.push({
        category: 'Failed Prisma Migrations in History',
        count: failedRows.length,
        details: failedRows,
        resolutionHint: 'Prisma migration history records one or more failed or rolled-back migrations. Resolve using: npx prisma migrate resolve',
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Migration history contains failed or rolled back migrations.',
      };
    }

    if (incompleteStepRows.length > 0) {
      conflicts.push({
        category: 'Incomplete Migration Execution (applied_steps_count < 1)',
        count: incompleteStepRows.length,
        details: incompleteStepRows,
        resolutionHint: 'One or more migrations did not finish executing steps. Inspect migration logs.',
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Migration history records incomplete steps count.',
      };
    }

    // Check database migration names vs disk migrations
    const diskMap = new Map(diskMigrations.map((m) => [m.name, m]));
    const appliedMap = new Map(appliedRows.map((r) => [r.migration_name, r]));

    // Check for unknown migrations in DB
    const unknownMigrations = appliedRows
      .map((r) => r.migration_name)
      .filter((name) => !diskMap.has(name));
    if (unknownMigrations.length > 0) {
      conflicts.push({
        category: 'Unknown Migrations Recorded in Database History',
        count: unknownMigrations.length,
        details: [{ unknownMigrations }],
        resolutionHint: `Database contains migration records not present on disk: ${unknownMigrations.join(', ')}. Inspect branch drift.`,
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: `Database contains unknown migration records: ${unknownMigrations.join(', ')}`,
      };
    }

    // Check for pending migrations on disk
    const pendingMigrations = diskMigrations
      .map((m) => m.name)
      .filter((name) => !appliedMap.has(name));
    if (pendingMigrations.length > 0) {
      conflicts.push({
        category: 'Pending/Unapplied Migrations on Disk',
        count: pendingMigrations.length,
        details: [{ pendingMigrations }],
        resolutionHint: `Database is missing migration(s) that exist on disk: ${pendingMigrations.join(', ')}. Deploy migrations before startup.`,
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: `Database is missing ${pendingMigrations.length} migration(s): ${pendingMigrations.join(', ')}`,
      };
    }

    // Verify SHA-256 Checksums!
    const checksumMismatches: Array<{ migration: string; dbChecksum: string; diskChecksum: string }> = [];
    for (const applied of appliedRows) {
      const disk = diskMap.get(applied.migration_name);
      if (disk && applied.checksum !== disk.checksum) {
        checksumMismatches.push({
          migration: applied.migration_name,
          dbChecksum: applied.checksum,
          diskChecksum: disk.checksum,
        });
      }
    }

    if (checksumMismatches.length > 0) {
      conflicts.push({
        category: 'Migration Checksum Mismatch (Altered Migration SQL)',
        count: checksumMismatches.length,
        details: checksumMismatches,
        resolutionHint: 'Checked-in migration.sql file has changed compared to applied database history. Do not alter applied migrations.',
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: 'Migration checksum mismatch detected between disk and database.',
      };
    }

    // 6. Validate Enums
    const enumRes = await client.query(`
      SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY e.enumsortorder ASC;
    `);
    const enumValuesMap = new Map<string, string[]>();
    for (const row of enumRes.rows) {
      if (!enumValuesMap.has(row.typname)) {
        enumValuesMap.set(row.typname, []);
      }
      enumValuesMap.get(row.typname)!.push(row.enumlabel);
    }

    const expectedEnums: Record<string, string[]> = {
      CollectionVisibility: ['PRIVATE', 'PUBLIC_LINK'],
      MediaType: ['MOVIE', 'TV'],
      WatchStatus: ['TO_WATCH', 'WATCHED'],
      MemberRole: ['MEMBER', 'ADMIN'],
      InvitationStatus: ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'],
    };

    for (const [enumName, expectedVals] of Object.entries(expectedEnums)) {
      const existingVals = enumValuesMap.get(enumName);
      if (!existingVals) {
        conflicts.push({
          category: `Missing Expected Enum Type: "${enumName}"`,
          count: 1,
          details: [{ enumName }],
          resolutionHint: `Enum type "${enumName}" does not exist in schema.`,
        });
        continue;
      }

      // Check missing values
      const missingVals = expectedVals.filter((v) => !existingVals.includes(v));
      if (missingVals.length > 0) {
        conflicts.push({
          category: `Incompatible Enum Values on "${enumName}"`,
          count: missingVals.length,
          details: [{ enumName, missingVals }],
          resolutionHint: `Enum "${enumName}" is missing required values: ${missingVals.join(', ')}.`,
        });
      }

      // Check unexpected extra values
      const extraVals = existingVals.filter((v) => !expectedVals.includes(v));
      if (extraVals.length > 0) {
        conflicts.push({
          category: `Unexpected Enum Values on "${enumName}"`,
          count: extraVals.length,
          details: [{ enumName, extraVals }],
          resolutionHint: `Enum "${enumName}" contains unexpected values: ${extraVals.join(', ')}.`,
        });
      }
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: 'Schema enum definition differences detected.',
      };
    }

    // 7. Deep Column & Type Verification
    const colRes = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name IN ('User', 'Collection', 'Movie', 'CollectionMovie', 'UserMovieWatchStatus', 'CollectionMember', 'CollaborationInvitation', 'Session');
    `);
    const tableColumns = new Map<string, Map<string, { data_type: string; is_nullable: string; column_default: string | null }>>();
    for (const row of colRes.rows) {
      if (!tableColumns.has(row.table_name)) {
        tableColumns.set(row.table_name, new Map());
      }
      tableColumns.get(row.table_name)!.set(row.column_name, {
        data_type: row.data_type,
        is_nullable: row.is_nullable,
        column_default: row.column_default,
      });
    }

    interface ColumnSpec {
      type: string;
      nullable: boolean;
      default: string | null;
    }

    const expectedColumnSpecs: Record<string, Record<string, ColumnSpec>> = {
      User: {
        id: { type: 'text', nullable: false, default: null },
        username: { type: 'text', nullable: false, default: null },
        email: { type: 'text', nullable: false, default: null },
        passwordHash: { type: 'text', nullable: false, default: null },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
      Collection: {
        id: { type: 'text', nullable: false, default: null },
        ownerId: { type: 'text', nullable: false, default: null },
        title: { type: 'text', nullable: false, default: null },
        description: { type: 'text', nullable: true, default: null },
        visibility: { type: 'USER-DEFINED', nullable: false, default: "'PRIVATE'::\"CollectionVisibility\"" },
        shareToken: { type: 'text', nullable: true, default: null },
        isDefaultWatchlist: { type: 'boolean', nullable: false, default: 'false' },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
      Movie: {
        id: { type: 'text', nullable: false, default: null },
        tmdbId: { type: 'integer', nullable: false, default: null },
        mediaType: { type: 'USER-DEFINED', nullable: false, default: "'MOVIE'::\"MediaType\"" },
        title: { type: 'text', nullable: false, default: null },
        originalTitle: { type: 'text', nullable: true, default: null },
        overview: { type: 'text', nullable: true, default: null },
        posterPath: { type: 'text', nullable: true, default: null },
        backdropPath: { type: 'text', nullable: true, default: null },
        releaseDate: { type: 'text', nullable: true, default: null },
        releaseYear: { type: 'integer', nullable: true, default: null },
        originalLanguage: { type: 'text', nullable: true, default: null },
        popularity: { type: 'double precision', nullable: true, default: null },
        voteAverage: { type: 'double precision', nullable: true, default: null },
        genres: { type: 'jsonb', nullable: false, default: "'[]'::jsonb" },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
      CollectionMovie: {
        id: { type: 'text', nullable: false, default: null },
        collectionId: { type: 'text', nullable: false, default: null },
        movieId: { type: 'text', nullable: false, default: null },
        addedBy: { type: 'text', nullable: false, default: null },
        status: { type: 'USER-DEFINED', nullable: false, default: "'TO_WATCH'::\"WatchStatus\"" },
        watchedAt: { type: 'timestamp without time zone', nullable: true, default: null },
        note: { type: 'text', nullable: true, default: null },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
      UserMovieWatchStatus: {
        id: { type: 'text', nullable: false, default: null },
        userId: { type: 'text', nullable: false, default: null },
        movieId: { type: 'text', nullable: false, default: null },
        status: { type: 'USER-DEFINED', nullable: false, default: '\'TO_WATCH\'::"WatchStatus"' },
        watchedAt: { type: 'timestamp without time zone', nullable: true, default: null },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
      CollectionMember: {
        id: { type: 'text', nullable: false, default: null },
        collectionId: { type: 'text', nullable: false, default: null },
        userId: { type: 'text', nullable: false, default: null },
        role: { type: 'USER-DEFINED', nullable: false, default: "'MEMBER'::\"MemberRole\"" },
        joinedAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
      },
      CollaborationInvitation: {
        id: { type: 'text', nullable: false, default: null },
        collectionId: { type: 'text', nullable: false, default: null },
        inviterId: { type: 'text', nullable: false, default: null },
        inviteeId: { type: 'text', nullable: false, default: null },
        status: { type: 'USER-DEFINED', nullable: false, default: "'PENDING'::\"InvitationStatus\"" },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        respondedAt: { type: 'timestamp without time zone', nullable: true, default: null },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
      Session: {
        id: { type: 'text', nullable: false, default: null },
        userId: { type: 'text', nullable: false, default: null },
        tokenHash: { type: 'text', nullable: false, default: null },
        previousTokenHash: { type: 'text', nullable: true, default: null },
        historicalTokenHashes: { type: 'ARRAY', nullable: true, default: 'ARRAY[]::text[]' },
        userAgent: { type: 'text', nullable: true, default: null },
        ipAddress: { type: 'text', nullable: true, default: null },
        expiresAt: { type: 'timestamp without time zone', nullable: false, default: null },
        revokedAt: { type: 'timestamp without time zone', nullable: true, default: null },
        rotatedAt: { type: 'timestamp without time zone', nullable: true, default: null },
        createdAt: { type: 'timestamp without time zone', nullable: false, default: 'CURRENT_TIMESTAMP' },
        updatedAt: { type: 'timestamp without time zone', nullable: false, default: null },
      },
    };

    function matchesColumnDefault(actual: string | null | undefined, expected: string | null): boolean {
      if (expected === null) {
        return actual === null || actual === undefined || actual.trim() === '';
      }
      if (actual === null || actual === undefined) {
        return false;
      }
      const cleanActual = actual.trim();
      const cleanExpected = expected.trim();
      if (cleanActual === cleanExpected) return true;

      if (
        cleanExpected.toUpperCase() === 'CURRENT_TIMESTAMP' &&
        (cleanActual.toUpperCase() === 'CURRENT_TIMESTAMP' || cleanActual.toLowerCase() === 'now()')
      ) {
        return true;
      }
      if (
        cleanExpected.toLowerCase() === 'false' &&
        (cleanActual.toLowerCase() === 'false' || cleanActual.toLowerCase().startsWith('false::'))
      ) {
        return true;
      }
      if (
        cleanExpected === 'ARRAY[]::text[]' &&
        (cleanActual === 'ARRAY[]::text[]' || cleanActual === "'{}'::text[]")
      ) {
        return true;
      }
      if (
        cleanExpected === "'[]'::jsonb" &&
        (cleanActual === "'[]'::jsonb" || cleanActual === "'[]'")
      ) {
        return true;
      }
      if (cleanExpected.includes('::')) {
        const expectedValue = cleanExpected.split('::')[0].replace(/'/g, '').trim();
        if (cleanActual.includes(`'${expectedValue}'`)) {
          return true;
        }
      }

      return false;
    }

    for (const [tbl, cols] of Object.entries(expectedColumnSpecs)) {
      const existingCols = tableColumns.get(tbl);
      if (!existingCols) continue;
      for (const [colName, expectedSpec] of Object.entries(cols)) {
        const actual = existingCols.get(colName);
        if (!actual) {
          conflicts.push({
            category: `Missing Required Columns on Table "${tbl}"`,
            count: 1,
            details: [{ table: tbl, column: colName }],
            resolutionHint: `Table "${tbl}" is missing required column "${colName}".`,
          });
          continue;
        }

        // Compare data type
        if (actual.data_type !== expectedSpec.type) {
          conflicts.push({
            category: `Column Data Type Mismatch on "${tbl}.${colName}"`,
            count: 1,
            details: [{ table: tbl, column: colName, expected: expectedSpec.type, actual: actual.data_type }],
            resolutionHint: `Column "${tbl}.${colName}" has type "${actual.data_type}" (expected "${expectedSpec.type}").`,
          });
        }

        // Compare nullability
        const actualNullable = actual.is_nullable === 'YES';
        if (actualNullable !== expectedSpec.nullable) {
          conflicts.push({
            category: `Column Nullability Mismatch on "${tbl}.${colName}"`,
            count: 1,
            details: [{ table: tbl, column: colName, expectedNullable: expectedSpec.nullable, actualNullable }],
            resolutionHint: `Column "${tbl}.${colName}" nullability is ${actualNullable} (expected ${expectedSpec.nullable}).`,
          });
        }

        // Compare column defaults
        if (!matchesColumnDefault(actual.column_default, expectedSpec.default)) {
          conflicts.push({
            category: `Column Default Mismatch on "${tbl}.${colName}"`,
            count: 1,
            details: [{ table: tbl, column: colName, expectedDefault: expectedSpec.default, actualDefault: actual.column_default }],
            resolutionHint: `Column "${tbl}.${colName}" default is ${actual.column_default} (expected ${expectedSpec.default}).`,
          });
        }
      }

      // Check for unexpected extra columns
      for (const actualCol of existingCols.keys()) {
        if (!cols[actualCol]) {
          conflicts.push({
            category: `Unexpected Extra Column on Table "${tbl}"`,
            count: 1,
            details: [{ table: tbl, column: actualCol }],
            resolutionHint: `Table "${tbl}" contains unexpected extra column "${actualCol}".`,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Schema column drift, default mismatch, or extra columns detected.',
      };
    }

    // 8. Deep Validation of Constraints: Primary keys, Foreign keys, Unique constraints, Check constraints
    const constraintRes = await client.query(`
      SELECT 
        c.conname, 
        c.contype, 
        t.relname AS table_name,
        ft.relname AS foreign_table_name,
        c.confdeltype AS delete_action,
        c.confupdtype AS update_action,
        c.convalidated AS is_validated,
        c.condeferrable AS is_deferrable,
        pg_get_constraintdef(c.oid) AS condef,
        ARRAY(
          SELECT a.attname::text 
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord
        ) AS columns,
        ARRAY(
          SELECT fa.attname::text 
          FROM unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord)
          JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = fk.attnum
          ORDER BY fk.ord
        ) AS foreign_columns
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      LEFT JOIN pg_class ft ON c.confrelid = ft.oid
      WHERE n.nspname = 'public';
    `);
    const constraintMap = new Map<string, any>(
      constraintRes.rows.map((r: any) => [r.conname, r])
    );

    interface ConstraintSpec {
      name: string;
      type: 'f' | 'c' | 'p' | 'u';
      tableName: string;
      foreignTable?: string;
      columns?: string[];
      foreignColumns?: string[];
      deleteAction?: string; // 'c' for CASCADE
      updateAction?: string; // 'c' for CASCADE
      isDeferrable?: boolean;
      validateCheckDef?: (def: string) => boolean;
    }

    const requiredConstraints: ConstraintSpec[] = [
      // Foreign Keys (all configured with ON DELETE CASCADE and ON UPDATE CASCADE, not deferrable)
      {
        name: 'Collection_ownerId_fkey',
        type: 'f',
        tableName: 'Collection',
        foreignTable: 'User',
        columns: ['ownerId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollectionMovie_collectionId_fkey',
        type: 'f',
        tableName: 'CollectionMovie',
        foreignTable: 'Collection',
        columns: ['collectionId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollectionMovie_movieId_fkey',
        type: 'f',
        tableName: 'CollectionMovie',
        foreignTable: 'Movie',
        columns: ['movieId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollectionMovie_addedBy_fkey',
        type: 'f',
        tableName: 'CollectionMovie',
        foreignTable: 'User',
        columns: ['addedBy'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollectionMember_collectionId_fkey',
        type: 'f',
        tableName: 'CollectionMember',
        foreignTable: 'Collection',
        columns: ['collectionId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollectionMember_userId_fkey',
        type: 'f',
        tableName: 'CollectionMember',
        foreignTable: 'User',
        columns: ['userId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollaborationInvitation_collectionId_fkey',
        type: 'f',
        tableName: 'CollaborationInvitation',
        foreignTable: 'Collection',
        columns: ['collectionId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollaborationInvitation_inviterId_fkey',
        type: 'f',
        tableName: 'CollaborationInvitation',
        foreignTable: 'User',
        columns: ['inviterId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'CollaborationInvitation_inviteeId_fkey',
        type: 'f',
        tableName: 'CollaborationInvitation',
        foreignTable: 'User',
        columns: ['inviteeId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'Session_userId_fkey',
        type: 'f',
        tableName: 'Session',
        foreignTable: 'User',
        columns: ['userId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'UserMovieWatchStatus_userId_fkey',
        type: 'f',
        tableName: 'UserMovieWatchStatus',
        foreignTable: 'User',
        columns: ['userId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      {
        name: 'UserMovieWatchStatus_movieId_fkey',
        type: 'f',
        tableName: 'UserMovieWatchStatus',
        foreignTable: 'Movie',
        columns: ['movieId'],
        foreignColumns: ['id'],
        deleteAction: 'c',
        updateAction: 'c',
        isDeferrable: false,
      },
      // Check Constraint: personal watched status and timestamp synchronization
      {
        name: 'UserMovieWatchStatus_status_watchedAt_check',
        type: 'c',
        tableName: 'UserMovieWatchStatus',
        validateCheckDef: validateWatchedStatusCheckConstraint,
      },
      // Check Constraint: legacy collection-entry status and timestamp synchronization
      {
        name: 'CollectionMovie_status_watchedAt_check',
        type: 'c',
        tableName: 'CollectionMovie',
        validateCheckDef: validateWatchedStatusCheckConstraint,
      },
      // Primary Keys
      { name: 'User_pkey', type: 'p', tableName: 'User', columns: ['id'] },
      { name: 'Collection_pkey', type: 'p', tableName: 'Collection', columns: ['id'] },
      { name: 'Movie_pkey', type: 'p', tableName: 'Movie', columns: ['id'] },
      { name: 'CollectionMovie_pkey', type: 'p', tableName: 'CollectionMovie', columns: ['id'] },
      { name: 'CollectionMember_pkey', type: 'p', tableName: 'CollectionMember', columns: ['id'] },
      { name: 'CollaborationInvitation_pkey', type: 'p', tableName: 'CollaborationInvitation', columns: ['id'] },
      { name: 'Session_pkey', type: 'p', tableName: 'Session', columns: ['id'] },
      { name: 'UserMovieWatchStatus_pkey', type: 'p', tableName: 'UserMovieWatchStatus', columns: ['id'] },
    ];

    for (const reqCon of requiredConstraints) {
      const actual = constraintMap.get(reqCon.name);
      if (!actual) {
        conflicts.push({
          category: `Missing Required Database Constraint: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, expectedTable: reqCon.tableName }],
          resolutionHint: `Required database constraint "${reqCon.name}" is missing from schema.`,
        });
        continue;
      }

      if (actual.contype !== reqCon.type) {
        conflicts.push({
          category: `Constraint Type Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, expectedType: reqCon.type, actualType: actual.contype }],
          resolutionHint: `Constraint "${reqCon.name}" has type "${actual.contype}" (expected "${reqCon.type}").`,
        });
      }

      if (actual.table_name !== reqCon.tableName) {
        conflicts.push({
          category: `Constraint Table Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, expectedTable: reqCon.tableName, actualTable: actual.table_name }],
          resolutionHint: `Constraint "${reqCon.name}" is attached to "${actual.table_name}" (expected "${reqCon.tableName}").`,
        });
      }

      if (actual.is_validated !== true) {
        conflicts.push({
          category: `Unvalidated Database Constraint: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, isValidated: actual.is_validated }],
          resolutionHint: `Constraint "${reqCon.name}" is marked NOT VALID. Run VALIDATE CONSTRAINT.`,
        });
      }

      if (reqCon.isDeferrable !== undefined && actual.is_deferrable !== reqCon.isDeferrable) {
        conflicts.push({
          category: `Constraint Deferrability Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, expectedDeferrable: reqCon.isDeferrable, actualDeferrable: actual.is_deferrable }],
          resolutionHint: `Constraint "${reqCon.name}" deferrability is ${actual.is_deferrable} (expected ${reqCon.isDeferrable}).`,
        });
      }

      if (reqCon.columns && JSON.stringify(actual.columns) !== JSON.stringify(reqCon.columns)) {
        conflicts.push({
          category: `Constraint Columns Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, expectedColumns: reqCon.columns, actualColumns: actual.columns }],
          resolutionHint: `Constraint "${reqCon.name}" covers columns [${Array.isArray(actual.columns) ? actual.columns.join(', ') : actual.columns}] (expected [${reqCon.columns.join(', ')}]).`,
        });
      }

      if (reqCon.foreignTable && actual.foreign_table_name !== reqCon.foreignTable) {
        conflicts.push({
          category: `Foreign Key Target Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [
            {
              constraintName: reqCon.name,
              expectedForeignTable: reqCon.foreignTable,
              actualForeignTable: actual.foreign_table_name,
            },
          ],
          resolutionHint: `Foreign key "${reqCon.name}" targets "${actual.foreign_table_name}" (expected "${reqCon.foreignTable}").`,
        });
      }

      if (reqCon.foreignColumns && JSON.stringify(actual.foreign_columns) !== JSON.stringify(reqCon.foreignColumns)) {
        conflicts.push({
          category: `Foreign Key Referenced Columns Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [
            {
              constraintName: reqCon.name,
              expectedForeignColumns: reqCon.foreignColumns,
              actualForeignColumns: actual.foreign_columns,
            },
          ],
          resolutionHint: `Foreign key "${reqCon.name}" references columns [${Array.isArray(actual.foreign_columns) ? actual.foreign_columns.join(', ') : actual.foreign_columns}] (expected [${reqCon.foreignColumns.join(', ')}]).`,
        });
      }

      if (reqCon.deleteAction && actual.delete_action !== reqCon.deleteAction) {
        conflicts.push({
          category: `Foreign Key Delete Action Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [
            {
              constraintName: reqCon.name,
              expectedDeleteAction: reqCon.deleteAction,
              actualDeleteAction: actual.delete_action,
            },
          ],
          resolutionHint: `Foreign key "${reqCon.name}" has delete action "${actual.delete_action}" (expected "${reqCon.deleteAction}").`,
        });
      }

      if (reqCon.updateAction && actual.update_action !== reqCon.updateAction) {
        conflicts.push({
          category: `Foreign Key Update Action Mismatch: "${reqCon.name}"`,
          count: 1,
          details: [
            {
              constraintName: reqCon.name,
              expectedUpdateAction: reqCon.updateAction,
              actualUpdateAction: actual.update_action,
            },
          ],
          resolutionHint: `Foreign key "${reqCon.name}" has update action "${actual.update_action}" (expected "${reqCon.updateAction}").`,
        });
      }

      if (reqCon.validateCheckDef && !reqCon.validateCheckDef(actual.condef || '')) {
        conflicts.push({
          category: `Invalid Check Constraint Definition: "${reqCon.name}"`,
          count: 1,
          details: [{ constraintName: reqCon.name, actualDefinition: actual.condef }],
          resolutionHint: `Check constraint "${reqCon.name}" has invalid definition: "${actual.condef}".`,
        });
      }
    }

    // Deep Validation of Indexes: existence, uniqueness, readiness, validity, access method, and partial predicates
    const indexRes = await client.query(`
      SELECT 
        i.relname AS index_name,
        t.relname AS table_name,
        idx.indisunique AS is_unique,
        idx.indisvalid AS is_valid,
        idx.indisready AS is_ready,
        am.amname AS access_method,
        pg_get_indexdef(idx.indexrelid) AS index_def,
        pg_get_expr(idx.indpred, idx.indrelid) AS partial_predicate,
        ARRAY(
          SELECT pg_get_indexdef(idx.indexrelid, k.ord::integer, true)
          FROM generate_series(1, idx.indnatts) AS k(ord)
        ) AS indexed_columns
      FROM pg_index idx
      JOIN pg_class i ON idx.indexrelid = i.oid
      JOIN pg_class t ON idx.indrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_am am ON i.relam = am.oid
      WHERE n.nspname = 'public';
    `);
    const indexMap = new Map<string, any>(
      indexRes.rows.map((r: any) => [r.index_name, r])
    );

    // Fail immediately if any index on application tables is marked invalid (e.g. aborted CONCURRENTLY)
    for (const idx of indexRes.rows) {
      if (EXPECTED_APPLICATION_TABLES.includes(idx.table_name as any) && !idx.is_valid) {
        conflicts.push({
          category: `Invalid Database Index: "${idx.index_name}"`,
          count: 1,
          details: [{ indexName: idx.index_name, table: idx.table_name, isValid: idx.is_valid }],
          resolutionHint: `Index "${idx.index_name}" is marked invalid (indisvalid = false). Reindex or drop and recreate.`,
        });
      }
    }

    interface IndexSpec {
      name: string;
      tableName: string;
      unique: boolean;
      accessMethod?: string;
      requiredPredicateExact?: string;
      expectedColumns: string[];
      validateDef?: (def: string) => boolean;
    }

    const requiredIndexes: IndexSpec[] = [
      {
        name: 'User_username_key',
        tableName: 'User',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['username'],
      },
      {
        name: 'User_email_key',
        tableName: 'User',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['email'],
      },
      {
        name: 'User_username_lower_key',
        tableName: 'User',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['lower(username)'],
        validateDef: (def) => def.toLowerCase().includes('lower(username)'),
      },
      {
        name: 'User_email_lower_key',
        tableName: 'User',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['lower(email)'],
        validateDef: (def) => def.toLowerCase().includes('lower(email)'),
      },
      {
        name: 'Collection_owner_default_watchlist_key',
        tableName: 'Collection',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['ownerId'],
        requiredPredicateExact: '("isDefaultWatchlist" = true)',
      },
      {
        name: 'Movie_tmdbId_mediaType_key',
        tableName: 'Movie',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['tmdbId', 'mediaType'],
      },
      {
        name: 'CollectionMovie_collectionId_movieId_key',
        tableName: 'CollectionMovie',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['collectionId', 'movieId'],
      },
      {
        name: 'CollectionMember_collectionId_userId_key',
        tableName: 'CollectionMember',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['collectionId', 'userId'],
      },
      {
        name: 'Session_tokenHash_key',
        tableName: 'Session',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['tokenHash'],
      },
      {
        name: 'UserMovieWatchStatus_userId_movieId_key',
        tableName: 'UserMovieWatchStatus',
        unique: true,
        accessMethod: 'btree',
        expectedColumns: ['userId', 'movieId'],
      },
    ];

    for (const reqIdx of requiredIndexes) {
      const actual = indexMap.get(reqIdx.name);
      if (!actual) {
        conflicts.push({
          category: `Missing Required Database Index: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, expectedTable: reqIdx.tableName }],
          resolutionHint: `Required index "${reqIdx.name}" is missing from schema.`,
        });
        continue;
      }

      if (reqIdx.unique && !actual.is_unique) {
        conflicts.push({
          category: `Index Uniqueness Mismatch: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, expectedUnique: true, actualUnique: actual.is_unique }],
          resolutionHint: `Index "${reqIdx.name}" must be UNIQUE.`,
        });
      }

      if (reqIdx.accessMethod && actual.access_method !== reqIdx.accessMethod) {
        conflicts.push({
          category: `Index Access Method Mismatch: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, expectedMethod: reqIdx.accessMethod, actualMethod: actual.access_method }],
          resolutionHint: `Index "${reqIdx.name}" uses access method "${actual.access_method}" (expected "${reqIdx.accessMethod}").`,
        });
      }

      if (!actual.is_valid) {
        conflicts.push({
          category: `Invalid Database Index: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, isValid: actual.is_valid }],
          resolutionHint: `Index "${reqIdx.name}" is marked invalid (indisvalid = false).`,
        });
      }

      if (!actual.is_ready) {
        conflicts.push({
          category: `Not-Ready Database Index: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, isReady: actual.is_ready }],
          resolutionHint: `Index "${reqIdx.name}" is not ready (indisready = false).`,
        });
      }

      if (actual.table_name !== reqIdx.tableName) {
        conflicts.push({
          category: `Index Table Mismatch: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, expectedTable: reqIdx.tableName, actualTable: actual.table_name }],
          resolutionHint: `Index "${reqIdx.name}" is on table "${actual.table_name}" (expected "${reqIdx.tableName}").`,
        });
      }

      // Enforce column list and strict column ordering
      if (!reqIdx.expectedColumns || reqIdx.expectedColumns.length === 0) {
        conflicts.push({
          category: `Incomplete Index Specification: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, error: 'expectedColumns must be defined and non-empty' }],
          resolutionHint: `Index specification for "${reqIdx.name}" must specify expectedColumns.`,
        });
      } else {
        const rawActualCols: string[] = Array.isArray(actual.indexed_columns) ? actual.indexed_columns : [];
        const normalizedActualCols = rawActualCols.map((c: string) => c.replace(/["\s]/g, '').toLowerCase());
        const normalizedExpectedCols = reqIdx.expectedColumns.map((c: string) => c.replace(/["\s]/g, '').toLowerCase());

        let columnMismatch = false;
        if (normalizedActualCols.length !== normalizedExpectedCols.length) {
          columnMismatch = true;
        } else {
          for (let i = 0; i < normalizedExpectedCols.length; i++) {
            if (normalizedActualCols[i] !== normalizedExpectedCols[i]) {
              columnMismatch = true;
              break;
            }
          }
        }

        if (columnMismatch) {
          conflicts.push({
            category: `Index Columns or Column Ordering Mismatch: "${reqIdx.name}"`,
            count: 1,
            details: [
              {
                indexName: reqIdx.name,
                expectedColumns: reqIdx.expectedColumns,
                actualColumns: rawActualCols,
              },
            ],
            resolutionHint: `Index "${reqIdx.name}" covers columns [${rawActualCols.join(', ')}] (expected exact columns and order [${reqIdx.expectedColumns.join(', ')}]).`,
          });
        }
      }

      // Complete partial predicate validation: must strictly enforce ("isDefaultWatchlist" = true)
      if (reqIdx.requiredPredicateExact) {
        const actualPred = (actual.partial_predicate || '').trim();
        const normalizedActual = actualPred.toLowerCase().replace(/["\s()]/g, '');
        const normalizedExpected = reqIdx.requiredPredicateExact.toLowerCase().replace(/["\s()]/g, '');

        if (!actualPred || normalizedActual !== normalizedExpected) {
          conflicts.push({
            category: `Invalid Partial Predicate on Index: "${reqIdx.name}"`,
            count: 1,
            details: [
              {
                indexName: reqIdx.name,
                expectedPredicate: reqIdx.requiredPredicateExact,
                actualPredicate: actualPred,
                indexDef: actual.index_def,
              },
            ],
            resolutionHint: `Index "${reqIdx.name}" must specify exact partial filter: WHERE ${reqIdx.requiredPredicateExact}.`,
          });
        }
      }

      if (reqIdx.validateDef && !reqIdx.validateDef(actual.index_def || '')) {
        conflicts.push({
          category: `Invalid Index Expression Definition: "${reqIdx.name}"`,
          count: 1,
          details: [{ indexName: reqIdx.name, actualDefinition: actual.index_def }],
          resolutionHint: `Index "${reqIdx.name}" does not match required expression definition.`,
        });
      }
    }

    // 9. Full Data Integrity Checks
    console.log('🔍 Complete application schema detected. Running data integrity checks...');

    // 1. Case-Insensitive Duplicate Usernames
    const usernameDupes = await client.query(`
      SELECT LOWER(username) AS lower_val, array_agg(username) AS variants, array_agg(id) AS ids, COUNT(*) AS count
      FROM "User"
      GROUP BY LOWER(username)
      HAVING COUNT(*) > 1;
    `);
    if (usernameDupes.rows.length > 0) {
      conflicts.push({
        category: 'Case-Insensitive Duplicate Usernames',
        count: usernameDupes.rows.length,
        details: usernameDupes.rows,
        resolutionHint:
          'Manually resolve duplicate usernames using SQL: UPDATE "User" SET username = \'unique_name\' WHERE id = \'TARGET_ID\';',
      });
    }

    // 2. Case-Insensitive Duplicate Emails
    const emailDupes = await client.query(`
      SELECT LOWER(email) AS lower_val, array_agg(email) AS variants, array_agg(id) AS ids, COUNT(*) AS count
      FROM "User"
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1;
    `);
    if (emailDupes.rows.length > 0) {
      conflicts.push({
        category: 'Case-Insensitive Duplicate Emails',
        count: emailDupes.rows.length,
        details: emailDupes.rows,
        resolutionHint:
          'Manually update conflicting emails using SQL: UPDATE "User" SET email = \'unique_email@domain.com\' WHERE id = \'TARGET_ID\';',
      });
    }

    // 3. Multiple Default Watchlists per Owner
    const defaultWatchlistDupes = await client.query(`
      SELECT "ownerId", COUNT(*) AS count, array_agg(id) AS collection_ids
      FROM "Collection"
      WHERE "isDefaultWatchlist" = true
      GROUP BY "ownerId"
      HAVING COUNT(*) > 1;
    `);
    if (defaultWatchlistDupes.rows.length > 0) {
      conflicts.push({
        category: 'Multiple Default Watchlists per User',
        count: defaultWatchlistDupes.rows.length,
        details: defaultWatchlistDupes.rows,
        resolutionHint:
          'Retain one master default watchlist and set others to false: UPDATE "Collection" SET "isDefaultWatchlist" = false WHERE id = \'SECONDARY_ID\';',
      });
    }

    // 4. Inconsistent CollectionMovie status vs watchedAt
    const watchedStatusConflicts = await client.query(`
      SELECT id, "collectionId", "movieId", status, "watchedAt"
      FROM "CollectionMovie"
      WHERE (status = 'WATCHED' AND "watchedAt" IS NULL) OR (status = 'TO_WATCH' AND "watchedAt" IS NOT NULL);
    `);
    if (watchedStatusConflicts.rows.length > 0) {
      conflicts.push({
        category: 'Inconsistent Watch Status and Timestamp Pairs',
        count: watchedStatusConflicts.rows.length,
        details: watchedStatusConflicts.rows,
        resolutionHint:
          'Synchronize status and watchedAt on CollectionMovie to satisfy CHECK constraint.',
      });
    }

    // 5. Orphaned CollectionMovie -> Collection
    const orphanedCMCollection = await client.query(`
      SELECT cm.id, cm."collectionId"
      FROM "CollectionMovie" cm
      LEFT JOIN "Collection" c ON cm."collectionId" = c.id
      WHERE c.id IS NULL;
    `);
    if (orphanedCMCollection.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMovie-to-Collection References',
        count: orphanedCMCollection.rows.length,
        details: orphanedCMCollection.rows,
        resolutionHint: 'DELETE FROM "CollectionMovie" WHERE "collectionId" NOT IN (SELECT id FROM "Collection");',
      });
    }

    // 6. Orphaned CollectionMovie -> Movie
    const orphanedCMMovie = await client.query(`
      SELECT cm.id, cm."movieId"
      FROM "CollectionMovie" cm
      LEFT JOIN "Movie" m ON cm."movieId" = m.id
      WHERE m.id IS NULL;
    `);
    if (orphanedCMMovie.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMovie-to-Movie References',
        count: orphanedCMMovie.rows.length,
        details: orphanedCMMovie.rows,
        resolutionHint: 'DELETE FROM "CollectionMovie" WHERE "movieId" NOT IN (SELECT id FROM "Movie");',
      });
    }

    // 7. Orphaned CollectionMovie -> User (addedBy)
    const orphanedCMUser = await client.query(`
      SELECT cm.id, cm."addedBy"
      FROM "CollectionMovie" cm
      LEFT JOIN "User" u ON cm."addedBy" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedCMUser.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMovie-to-User References',
        count: orphanedCMUser.rows.length,
        details: orphanedCMUser.rows,
        resolutionHint: 'DELETE FROM "CollectionMovie" WHERE "addedBy" NOT IN (SELECT id FROM "User");',
      });
    }

    // 8. Orphaned CollectionMember -> Collection
    const orphanedMemberCollection = await client.query(`
      SELECT cm.id, cm."collectionId"
      FROM "CollectionMember" cm
      LEFT JOIN "Collection" c ON cm."collectionId" = c.id
      WHERE c.id IS NULL;
    `);
    if (orphanedMemberCollection.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMember-to-Collection References',
        count: orphanedMemberCollection.rows.length,
        details: orphanedMemberCollection.rows,
        resolutionHint: 'DELETE FROM "CollectionMember" WHERE "collectionId" NOT IN (SELECT id FROM "Collection");',
      });
    }

    // 9. Orphaned CollectionMember -> User
    const orphanedMemberUser = await client.query(`
      SELECT cm.id, cm."userId"
      FROM "CollectionMember" cm
      LEFT JOIN "User" u ON cm."userId" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedMemberUser.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMember-to-User References',
        count: orphanedMemberUser.rows.length,
        details: orphanedMemberUser.rows,
        resolutionHint: 'DELETE FROM "CollectionMember" WHERE "userId" NOT IN (SELECT id FROM "User");',
      });
    }

    // 10. Orphaned CollaborationInvitation -> Collection
    const orphanedInviteCollection = await client.query(`
      SELECT ci.id, ci."collectionId"
      FROM "CollaborationInvitation" ci
      LEFT JOIN "Collection" c ON ci."collectionId" = c.id
      WHERE c.id IS NULL;
    `);
    if (orphanedInviteCollection.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollaborationInvitation-to-Collection References',
        count: orphanedInviteCollection.rows.length,
        details: orphanedInviteCollection.rows,
        resolutionHint: 'DELETE FROM "CollaborationInvitation" WHERE "collectionId" NOT IN (SELECT id FROM "Collection");',
      });
    }

    // 11. Orphaned CollaborationInvitation -> User
    const orphanedInviteUser = await client.query(`
      SELECT ci.id, ci."inviterId", ci."inviteeId"
      FROM "CollaborationInvitation" ci
      LEFT JOIN "User" u1 ON ci."inviterId" = u1.id
      LEFT JOIN "User" u2 ON ci."inviteeId" = u2.id
      WHERE u1.id IS NULL OR u2.id IS NULL;
    `);
    if (orphanedInviteUser.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollaborationInvitation-to-User References',
        count: orphanedInviteUser.rows.length,
        details: orphanedInviteUser.rows,
        resolutionHint: 'DELETE FROM "CollaborationInvitation" WHERE "inviterId" NOT IN (SELECT id FROM "User") OR "inviteeId" NOT IN (SELECT id FROM "User");',
      });
    }

    // 12. Orphaned Session -> User
    const orphanedSessions = await client.query(`
      SELECT s.id, s."userId"
      FROM "Session" s
      LEFT JOIN "User" u ON s."userId" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedSessions.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned Sessions',
        count: orphanedSessions.rows.length,
        details: orphanedSessions.rows,
        resolutionHint: 'DELETE FROM "Session" WHERE "userId" NOT IN (SELECT id FROM "User");',
      });
    }

    // 13. Orphaned Collection -> User (ownerId)
    const orphanedCollections = await client.query(`
      SELECT c.id, c."ownerId"
      FROM "Collection" c
      LEFT JOIN "User" u ON c."ownerId" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedCollections.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned Collections (Invalid Owner)',
        count: orphanedCollections.rows.length,
        details: orphanedCollections.rows,
        resolutionHint: 'DELETE FROM "Collection" WHERE "ownerId" NOT IN (SELECT id FROM "User");',
      });
    }

    const success = conflicts.length === 0;
    return {
      success,
      state: success ? 'VALID' : 'INCONSISTENT',
      databaseName: currentDb,
      conflicts,
    };
  } finally {
    if (client) {
      client.release();
    }
    if (shouldClosePool) {
      await pool.end();
    }
  }
}

async function cli() {
  console.log('🔍 Executing CineTrack Database Migration Preflight Diagnostics...');
  try {
    const targetUrl = process.env.TARGET_DATABASE_URL || process.argv[2];
    const { success, state, conflicts, databaseName, error } = await runMigrationPreflight(targetUrl);

    if (!success) {
      console.error(`\n🚨 MIGRATION PREFLIGHT ABORTED on database "${databaseName}" [State: ${state}]:`);
      if (error) {
        console.error(`❌ ${error}`);
      }
      for (const conflict of conflicts) {
        console.error(`\n❌ [${conflict.category}] (${conflict.count} conflict groups found):`);
        console.error(JSON.stringify(conflict.details, null, 2));
        console.error(`👉 Manual Remediation: ${conflict.resolutionHint}`);
      }
      console.error('\n🛑 Preflight safety gate halted execution to prevent migration failure or database inconsistency.');
      process.exit(1);
    }

    console.log(`✅ Preflight verification successful for "${databaseName}" [State: ${state}]. Target database is clean and ready for migration deployment.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to execute migration preflight diagnostics:', err);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('migration_preflight')) {
  cli();
}
