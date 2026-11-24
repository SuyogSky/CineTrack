/**
 * CineTrack Schema Manifest
 *
 * Centralized, explicit, version-controlled definition of the expected
 * PostgreSQL database schema for CineTrack production and restored databases.
 */

export interface ColumnManifest {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  default: string | null;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  isIdentity: boolean;
  isGenerated: boolean;
  generationExpression: string | null;
  collationName: string | null;
}

export interface TableManifest {
  name: string;
  columns: Record<string, ColumnManifest>;
  primaryKey: string[];
}

export interface ForeignKeyManifest {
  name: string;
  table: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  deleteAction: 'c' | 'a' | 'r' | 'n' | 'd'; // 'c' = CASCADE
  updateAction: 'c' | 'a' | 'r' | 'n' | 'd'; // 'c' = CASCADE
  isDeferrable: boolean;
  isInitiallyDeferred: boolean;
  isValidated: boolean;
}

export interface CheckConstraintManifest {
  name: string;
  table: string;
  isValidated: boolean;
  isDeferrable: boolean;
  isInitiallyDeferred: boolean;
  semanticValidator: (definition: string) => boolean;
}

export interface UniqueConstraintManifest {
  name: string;
  table: string;
  columns: string[];
  isDeferrable: boolean;
  isInitiallyDeferred: boolean;
  isValidated: boolean;
}

export interface IndexManifest {
  name: string;
  table: string;
  unique: boolean;
  accessMethod: string;
  keyColumns: string[];
  includedColumns: string[];
  operatorClasses: string[];
  isDescending: boolean[];
  isNullsFirst: boolean[];
  predicate: string | null;
}

export interface MigrationManifest {
  name: string;
  checksum: string;
}

export interface SchemaManifest {
  version: string;
  tables: Record<string, TableManifest>;
  foreignKeys: ForeignKeyManifest[];
  uniqueConstraints: UniqueConstraintManifest[];
  checkConstraints: CheckConstraintManifest[];
  indexes: IndexManifest[];
  migrations: MigrationManifest[];
}

/**
 * Normalizes PostgreSQL column default expressions for robust comparison.
 * Handles differences in quoting, casts, and equivalent function calls.
 */
export function normalizeDefaultExpression(def: string | null): string | null {
  if (def === null || def === undefined) return null;
  let normalized = def.trim();

  // Strip outer parentheses repeatedly: ((false)) -> false
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    // Ensure the outer parentheses actually match (not separate clauses)
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < normalized.length - 1; i++) {
      if (normalized[i] === '(') depth++;
      else if (normalized[i] === ')') depth--;
      if (depth === 0) {
        balanced = false;
        break;
      }
    }
    if (balanced) {
      normalized = normalized.slice(1, -1).trim();
    } else {
      break;
    }
  }

  // Normalize common equivalents
  if (normalized.toLowerCase() === 'current_timestamp' || normalized.toLowerCase() === 'now()') {
    return 'CURRENT_TIMESTAMP';
  }
  if (normalized.toLowerCase() === 'false') {
    return 'false';
  }
  if (normalized.toLowerCase() === 'true') {
    return 'true';
  }
  if (normalized === '0' || normalized === "'0'::integer") {
    return '0';
  }
  if (normalized.toLowerCase() === "'[]'::jsonb") {
    return "'[]'::jsonb";
  }
  if (normalized.toLowerCase() === 'array[]::text[]' || normalized.toLowerCase() === 'array[]::text') {
    return 'ARRAY[]::text[]';
  }

  // Normalize enum casts: "'PRIVATE'::\"CollectionVisibility\"" vs "'PRIVATE'::CollectionVisibility"
  normalized = normalized.replace(/::"?([A-Za-z0-9_]+)"?/g, '::$1');

  return normalized;
}

function splitTopLevel(expr: string, operator: 'OR' | 'AND'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';
  let lastIdx = 0;
  const opPattern = new RegExp(`^\\s+${operator}\\s+`, 'i');

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if ((ch === "'" || ch === '"') && !inQuote) {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === quoteChar && inQuote) {
      inQuote = false;
    } else if (!inQuote) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0) {
        const remaining = expr.slice(i);
        const match = remaining.match(opPattern);
        if (match) {
          parts.push(expr.slice(lastIdx, i).trim());
          i += match[0].length - 1;
          lastIdx = i + 1;
        }
      }
    }
  }
  parts.push(expr.slice(lastIdx).trim());
  return parts.filter((p) => p.length > 0);
}

function stripOuterParens(str: string): string {
  let s = str.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) {
        balanced = false;
        break;
      }
    }
    if (balanced) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return s;
}

function normalizeConstraintTerm(term: string): string {
  let t = stripOuterParens(term).trim();
  // Strip enum cast: ::"WatchStatus" or ::WatchStatus
  t = t.replace(/::"?([A-Za-z0-9_]+)"?/g, '');
  // Normalize quotes on identifiers: "watchedAt" -> watchedat, "status" -> status
  t = t.replace(/"status"/gi, 'status').replace(/"watchedAt"/gi, 'watchedat');
  // Normalize spacing around operators
  t = t.replace(/\s*=\s*/g, '=').replace(/\s+/g, ' ').toLowerCase().trim();
  return t;
}

/**
 * Semantic validator for the CollectionMovie watched-status CHECK constraint.
 *
 * Enforces the strict business invariant:
 * - When status is 'WATCHED', watchedAt MUST be NOT NULL.
 * - When status is 'TO_WATCH', watchedAt MUST be NULL.
 *
 * Uses top-level AST/clause decomposition to strictly reject:
 * - Extra permissive branches (e.g. "OR status = 'WATCHED'")
 * - Tautologies / bypasses (e.g. "OR TRUE", "OR 1=1", "OR 'a'='a'")
 * - Missing required conditions
 * - Reversed/inverted conditions
 */
export function validateWatchedStatusConstraintSemantics(definition: string): boolean {
  if (!definition || typeof definition !== 'string') return false;

  // Immediate rejection of blatant tautologies
  if (
    /\bOR\s+TRUE\b/i.test(definition) ||
    /\bOR\s+1\s*=\s*1\b/i.test(definition) ||
    /\bOR\s+'a'\s*=\s*'a'/i.test(definition) ||
    /\bOR\s+NOT\s+FALSE\b/i.test(definition)
  ) {
    return false;
  }

  let expr = definition.trim();
  if (expr.toUpperCase().startsWith('CHECK')) {
    expr = expr.slice(5).trim();
  }
  expr = stripOuterParens(expr);

  // Top-level decomposition: MUST be exactly two mutually exclusive OR branches
  const branches = splitTopLevel(expr, 'OR');
  if (branches.length !== 2) {
    return false;
  }

  const validWatchedBranch = new Set(["status='watched'", "watchedat is not null"]);
  const validToWatchBranch = new Set(["status='to_watch'", "watchedat is null"]);

  let matchedWatched = false;
  let matchedToWatch = false;

  for (const branch of branches) {
    const unrolledBranch = stripOuterParens(branch);
    const terms = splitTopLevel(unrolledBranch, 'AND');
    if (terms.length !== 2) {
      return false;
    }

    const normTerms = terms.map(normalizeConstraintTerm);
    const termSet = new Set(normTerms);
    if (termSet.size !== 2) return false;

    const isWatched = normTerms.every((t) => validWatchedBranch.has(t));
    const isToWatch = normTerms.every((t) => validToWatchBranch.has(t));

    if (isWatched && !matchedWatched) {
      matchedWatched = true;
    } else if (isToWatch && !matchedToWatch) {
      matchedToWatch = true;
    } else {
      return false;
    }
  }

  return matchedWatched && matchedToWatch;
}

export const CINETRACK_SCHEMA_MANIFEST: SchemaManifest = {
  version: '20261123120000',
  tables: {
    User: {
      name: 'User',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        username: { name: 'username', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        email: { name: 'email', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        passwordHash: { name: 'passwordHash', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        createdAt: { name: 'createdAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        updatedAt: { name: 'updatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    Movie: {
      name: 'Movie',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        tmdbId: { name: 'tmdbId', dataType: 'integer', udtName: 'int4', nullable: false, default: null, maxLength: null, numericPrecision: 32, numericScale: 0, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        mediaType: { name: 'mediaType', dataType: 'USER-DEFINED', udtName: 'MediaType', nullable: false, default: "'MOVIE'::MediaType", maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        title: { name: 'title', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        originalTitle: { name: 'originalTitle', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        overview: { name: 'overview', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        posterPath: { name: 'posterPath', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        backdropPath: { name: 'backdropPath', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        releaseDate: { name: 'releaseDate', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        releaseYear: { name: 'releaseYear', dataType: 'integer', udtName: 'int4', nullable: true, default: null, maxLength: null, numericPrecision: 32, numericScale: 0, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        originalLanguage: { name: 'originalLanguage', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        popularity: { name: 'popularity', dataType: 'double precision', udtName: 'float8', nullable: true, default: null, maxLength: null, numericPrecision: 53, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        voteAverage: { name: 'voteAverage', dataType: 'double precision', udtName: 'float8', nullable: true, default: null, maxLength: null, numericPrecision: 53, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        genres: { name: 'genres', dataType: 'jsonb', udtName: 'jsonb', nullable: false, default: "'[]'::jsonb", maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        createdAt: { name: 'createdAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        updatedAt: { name: 'updatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    Collection: {
      name: 'Collection',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        ownerId: { name: 'ownerId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        title: { name: 'title', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        description: { name: 'description', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        visibility: { name: 'visibility', dataType: 'USER-DEFINED', udtName: 'CollectionVisibility', nullable: false, default: "'PRIVATE'::CollectionVisibility", maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        shareToken: { name: 'shareToken', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        isDefaultWatchlist: { name: 'isDefaultWatchlist', dataType: 'boolean', udtName: 'bool', nullable: false, default: 'false', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        createdAt: { name: 'createdAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        updatedAt: { name: 'updatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    CollectionMovie: {
      name: 'CollectionMovie',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        collectionId: { name: 'collectionId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        movieId: { name: 'movieId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        addedBy: { name: 'addedBy', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        status: { name: 'status', dataType: 'USER-DEFINED', udtName: 'WatchStatus', nullable: false, default: "'TO_WATCH'::WatchStatus", maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        watchedAt: { name: 'watchedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        note: { name: 'note', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        createdAt: { name: 'createdAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        updatedAt: { name: 'updatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    CollectionMember: {
      name: 'CollectionMember',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        collectionId: { name: 'collectionId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        userId: { name: 'userId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        role: { name: 'role', dataType: 'USER-DEFINED', udtName: 'MemberRole', nullable: false, default: "'MEMBER'::MemberRole", maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        joinedAt: { name: 'joinedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    CollaborationInvitation: {
      name: 'CollaborationInvitation',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        collectionId: { name: 'collectionId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        inviterId: { name: 'inviterId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        inviteeId: { name: 'inviteeId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        status: { name: 'status', dataType: 'USER-DEFINED', udtName: 'InvitationStatus', nullable: false, default: "'PENDING'::InvitationStatus", maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        createdAt: { name: 'createdAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        respondedAt: { name: 'respondedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        updatedAt: { name: 'updatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    Session: {
      name: 'Session',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        userId: { name: 'userId', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        tokenHash: { name: 'tokenHash', dataType: 'text', udtName: 'text', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        userAgent: { name: 'userAgent', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        ipAddress: { name: 'ipAddress', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        expiresAt: { name: 'expiresAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        revokedAt: { name: 'revokedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        createdAt: { name: 'createdAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        updatedAt: { name: 'updatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: false, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        previousTokenHash: { name: 'previousTokenHash', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        rotatedAt: { name: 'rotatedAt', dataType: 'timestamp without time zone', udtName: 'timestamp', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        historicalTokenHashes: { name: 'historicalTokenHashes', dataType: 'ARRAY', udtName: '_text', nullable: true, default: 'ARRAY[]::text[]', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
    _prisma_migrations: {
      name: '_prisma_migrations',
      primaryKey: ['id'],
      columns: {
        id: { name: 'id', dataType: 'character varying', udtName: 'varchar', nullable: false, default: null, maxLength: 36, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        checksum: { name: 'checksum', dataType: 'character varying', udtName: 'varchar', nullable: false, default: null, maxLength: 64, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        finished_at: { name: 'finished_at', dataType: 'timestamp with time zone', udtName: 'timestamptz', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        migration_name: { name: 'migration_name', dataType: 'character varying', udtName: 'varchar', nullable: false, default: null, maxLength: 255, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        logs: { name: 'logs', dataType: 'text', udtName: 'text', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        rolled_back_at: { name: 'rolled_back_at', dataType: 'timestamp with time zone', udtName: 'timestamptz', nullable: true, default: null, maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        started_at: { name: 'started_at', dataType: 'timestamp with time zone', udtName: 'timestamptz', nullable: false, default: 'CURRENT_TIMESTAMP', maxLength: null, numericPrecision: null, numericScale: null, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
        applied_steps_count: { name: 'applied_steps_count', dataType: 'integer', udtName: 'int4', nullable: false, default: '0', maxLength: null, numericPrecision: 32, numericScale: 0, isIdentity: false, isGenerated: false, generationExpression: null, collationName: null },
      },
    },
  },
  foreignKeys: [
    { name: 'Collection_ownerId_fkey', table: 'Collection', columns: ['ownerId'], foreignTable: 'User', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollectionMovie_collectionId_fkey', table: 'CollectionMovie', columns: ['collectionId'], foreignTable: 'Collection', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollectionMovie_movieId_fkey', table: 'CollectionMovie', columns: ['movieId'], foreignTable: 'Movie', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollectionMovie_addedBy_fkey', table: 'CollectionMovie', columns: ['addedBy'], foreignTable: 'User', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollectionMember_collectionId_fkey', table: 'CollectionMember', columns: ['collectionId'], foreignTable: 'Collection', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollectionMember_userId_fkey', table: 'CollectionMember', columns: ['userId'], foreignTable: 'User', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollaborationInvitation_collectionId_fkey', table: 'CollaborationInvitation', columns: ['collectionId'], foreignTable: 'Collection', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollaborationInvitation_inviterId_fkey', table: 'CollaborationInvitation', columns: ['inviterId'], foreignTable: 'User', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'CollaborationInvitation_inviteeId_fkey', table: 'CollaborationInvitation', columns: ['inviteeId'], foreignTable: 'User', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
    { name: 'Session_userId_fkey', table: 'Session', columns: ['userId'], foreignTable: 'User', foreignColumns: ['id'], deleteAction: 'c', updateAction: 'c', isDeferrable: false, isInitiallyDeferred: false, isValidated: true },
  ],
  uniqueConstraints: [],
  checkConstraints: [
    {
      name: 'CollectionMovie_status_watchedAt_check',
      table: 'CollectionMovie',
      isValidated: true,
      isDeferrable: false,
      isInitiallyDeferred: false,
      semanticValidator: validateWatchedStatusConstraintSemantics,
    },
  ],
  indexes: [
    // Primary Key Indexes
    { name: 'User_pkey', table: 'User', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Movie_pkey', table: 'Movie', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Collection_pkey', table: 'Collection', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollectionMovie_pkey', table: 'CollectionMovie', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollectionMember_pkey', table: 'CollectionMember', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollaborationInvitation_pkey', table: 'CollaborationInvitation', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Session_pkey', table: 'Session', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: '_prisma_migrations_pkey', table: '_prisma_migrations', unique: true, accessMethod: 'btree', keyColumns: ['id'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },

    // Unique Indexes
    { name: 'User_username_key', table: 'User', unique: true, accessMethod: 'btree', keyColumns: ['username'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'User_email_key', table: 'User', unique: true, accessMethod: 'btree', keyColumns: ['email'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'User_username_lower_key', table: 'User', unique: true, accessMethod: 'btree', keyColumns: ['lower(username)'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'User_email_lower_key', table: 'User', unique: true, accessMethod: 'btree', keyColumns: ['lower(email)'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Collection_shareToken_key', table: 'Collection', unique: true, accessMethod: 'btree', keyColumns: ['"shareToken"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Collection_owner_default_watchlist_key', table: 'Collection', unique: true, accessMethod: 'btree', keyColumns: ['"ownerId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: '("isDefaultWatchlist" = true)' },
    { name: 'Movie_tmdbId_mediaType_key', table: 'Movie', unique: true, accessMethod: 'btree', keyColumns: ['"tmdbId"', '"mediaType"'], includedColumns: [], operatorClasses: ['int4_ops', 'enum_ops'], isDescending: [false, false], isNullsFirst: [false, false], predicate: null },
    { name: 'CollectionMovie_collectionId_movieId_key', table: 'CollectionMovie', unique: true, accessMethod: 'btree', keyColumns: ['"collectionId"', '"movieId"'], includedColumns: [], operatorClasses: ['text_ops', 'text_ops'], isDescending: [false, false], isNullsFirst: [false, false], predicate: null },
    { name: 'CollectionMember_collectionId_userId_key', table: 'CollectionMember', unique: true, accessMethod: 'btree', keyColumns: ['"collectionId"', '"userId"'], includedColumns: [], operatorClasses: ['text_ops', 'text_ops'], isDescending: [false, false], isNullsFirst: [false, false], predicate: null },
    { name: 'Session_tokenHash_key', table: 'Session', unique: true, accessMethod: 'btree', keyColumns: ['"tokenHash"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },

    // Non-Unique Indexes
    { name: 'User_email_idx', table: 'User', unique: false, accessMethod: 'btree', keyColumns: ['email'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'User_username_idx', table: 'User', unique: false, accessMethod: 'btree', keyColumns: ['username'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Movie_mediaType_idx', table: 'Movie', unique: false, accessMethod: 'btree', keyColumns: ['"mediaType"'], includedColumns: [], operatorClasses: ['enum_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Movie_tmdbId_mediaType_idx', table: 'Movie', unique: false, accessMethod: 'btree', keyColumns: ['"tmdbId"', '"mediaType"'], includedColumns: [], operatorClasses: ['int4_ops', 'enum_ops'], isDescending: [false, false], isNullsFirst: [false, false], predicate: null },
    { name: 'Collection_ownerId_idx', table: 'Collection', unique: false, accessMethod: 'btree', keyColumns: ['"ownerId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Collection_visibility_shareToken_idx', table: 'Collection', unique: false, accessMethod: 'btree', keyColumns: ['visibility', '"shareToken"'], includedColumns: [], operatorClasses: ['enum_ops', 'text_ops'], isDescending: [false, false], isNullsFirst: [false, false], predicate: null },
    { name: 'CollectionMovie_collectionId_idx', table: 'CollectionMovie', unique: false, accessMethod: 'btree', keyColumns: ['"collectionId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollectionMovie_movieId_idx', table: 'CollectionMovie', unique: false, accessMethod: 'btree', keyColumns: ['"movieId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollectionMovie_status_idx', table: 'CollectionMovie', unique: false, accessMethod: 'btree', keyColumns: ['status'], includedColumns: [], operatorClasses: ['enum_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollectionMember_collectionId_idx', table: 'CollectionMember', unique: false, accessMethod: 'btree', keyColumns: ['"collectionId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollectionMember_userId_idx', table: 'CollectionMember', unique: false, accessMethod: 'btree', keyColumns: ['"userId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollaborationInvitation_collectionId_idx', table: 'CollaborationInvitation', unique: false, accessMethod: 'btree', keyColumns: ['"collectionId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'CollaborationInvitation_inviteeId_status_idx', table: 'CollaborationInvitation', unique: false, accessMethod: 'btree', keyColumns: ['"inviteeId"', 'status'], includedColumns: [], operatorClasses: ['text_ops', 'enum_ops'], isDescending: [false, false], isNullsFirst: [false, false], predicate: null },
    { name: 'CollaborationInvitation_inviterId_idx', table: 'CollaborationInvitation', unique: false, accessMethod: 'btree', keyColumns: ['"inviterId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Session_previousTokenHash_idx', table: 'Session', unique: false, accessMethod: 'btree', keyColumns: ['"previousTokenHash"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Session_tokenHash_idx', table: 'Session', unique: false, accessMethod: 'btree', keyColumns: ['"tokenHash"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
    { name: 'Session_userId_idx', table: 'Session', unique: false, accessMethod: 'btree', keyColumns: ['"userId"'], includedColumns: [], operatorClasses: ['text_ops'], isDescending: [false], isNullsFirst: [false], predicate: null },
  ],
  migrations: [
    { name: '20261116083539_init', checksum: '9989fd17b5f3529330bb45f32c301386f55c829bc98a4b489202e692ce300eea' },
    { name: '20261116123000_add_media_type', checksum: '035a037329221fe08a8371c8806d0f3db739a3ae155018370a5cc8855e463b52' },
    { name: '20261117103000_security_and_integrity_hardening', checksum: '54986e195b94fbe00983c2e19ee253cb2738e6bd14c3c79015b62848224cd470' },
    { name: '20261117123000_token_family_history', checksum: 'd6272eb5f9cebf5736e5f01deeb8fb4328ea0ff34bc6d1631aa7e41f6155c2c3' },
    { name: '20261123120000_watched_status_check_constraint', checksum: 'ee2ac0819623083ee8f1fff9225a566a2769b4267b19f17ad28650afd3b6f988' },
  ],
};
