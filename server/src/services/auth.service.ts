import crypto from 'crypto';
import { prisma } from '../config/database';
import { hashPassword, verifyPassword } from '../utils/password';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  verifyRefreshToken,
  verifyAccessToken,
} from '../utils/jwt';
import { RegisterInput, LoginInput } from '../validators/auth.validator';
import { AppError, ConflictError, UnauthorizedError } from '../utils/errors';
import { AuthUserPayload } from '../types';

export class AuthService {
  static async register(input: RegisterInput, userAgent?: string, ipAddress?: string) {
    const normalizedEmail = input.email.toLowerCase().trim();
    const normalizedUsername = input.username.trim();

    // Check existing user with case-insensitive matching
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: normalizedEmail, mode: 'insensitive' } },
          { username: { equals: normalizedUsername, mode: 'insensitive' } },
        ],
      },
    });

    if (existing) {
      if (existing.email.toLowerCase() === normalizedEmail) {
        throw new ConflictError('An account with this email already exists');
      }
      if (existing.username.toLowerCase() === normalizedUsername.toLowerCase()) {
        throw new ConflictError('This username is already taken');
      }
    }

    const passwordHash = await hashPassword(input.password);

    // Create user and default watchlist transactionally
    let user;
    try {
      user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            username: normalizedUsername,
            email: normalizedEmail,
            passwordHash,
          },
        });

        // Default personal watchlist
        await tx.collection.create({
          data: {
            ownerId: newUser.id,
            title: 'My Watchlist',
            description: 'Personal master watchlist for movies to watch.',
            visibility: 'PRIVATE',
            isDefaultWatchlist: true,
          },
        });

        return newUser;
      });
    } catch (err: unknown) {
      // Catch unique constraint violation from PostgreSQL/Prisma
      const error = err as { code?: string; meta?: { target?: string[] | string } };
      if (error?.code === 'P2002') {
        const targetStr = JSON.stringify(error.meta?.target || '').toLowerCase();
        if (targetStr.includes('email')) {
          throw new ConflictError('An account with this email already exists');
        }
        throw new ConflictError('This username is already taken');
      }
      throw err;
    }

    const userPayload: AuthUserPayload = {
      id: user.id,
      username: user.username,
      email: user.email,
    };

    // Create session atomically with cryptographic UUID
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const accessToken = generateAccessToken(userPayload, sessionId);
    const refreshToken = generateRefreshToken(userPayload, sessionId);
    const hashedRefreshToken = hashToken(refreshToken);

    await prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: hashedRefreshToken,
        userAgent,
        ipAddress,
        expiresAt,
      },
    });

    return {
      user: userPayload,
      accessToken,
      refreshToken,
    };
  }

  static async login(input: LoginInput, userAgent?: string, ipAddress?: string) {
    const identifier = input.identifier.trim();
    const isEmail = identifier.includes('@');

    const user = await prisma.user.findFirst({
      where: isEmail
        ? { email: { equals: identifier.toLowerCase(), mode: 'insensitive' } }
        : { username: { equals: identifier, mode: 'insensitive' } },
    });

    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const isValid = await verifyPassword(user.passwordHash, input.password);
    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Ensure user has a default watchlist if one doesn't exist
    const defaultWatchlist = await prisma.collection.findFirst({
      where: { ownerId: user.id, isDefaultWatchlist: true },
    });

    if (!defaultWatchlist) {
      try {
        await prisma.collection.create({
          data: {
            ownerId: user.id,
            title: 'My Watchlist',
            description: 'Personal master watchlist for movies to watch.',
            visibility: 'PRIVATE',
            isDefaultWatchlist: true,
          },
        });
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code !== 'P2002') {
          throw err;
        }
      }
    }

    const userPayload: AuthUserPayload = {
      id: user.id,
      username: user.username,
      email: user.email,
    };

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const accessToken = generateAccessToken(userPayload, sessionId);
    const refreshToken = generateRefreshToken(userPayload, sessionId);
    const hashedRefreshToken = hashToken(refreshToken);

    await prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: hashedRefreshToken,
        userAgent,
        ipAddress,
        expiresAt,
      },
    });

    return {
      user: userPayload,
      accessToken,
      refreshToken,
    };
  }

  static async rotateRefreshToken(
    refreshToken: string,
    userAgent?: string,
    ipAddress?: string
  ) {
    if (!refreshToken) {
      throw new UnauthorizedError('Refresh token required');
    }

    // 1. Verify token signature and claims
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded || !decoded.sessionId) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const incomingHash = hashToken(refreshToken);

    // 2. Interactive transaction with row-level locking (SELECT FOR UPDATE)
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          userId: string;
          tokenHash: string;
          previousTokenHash: string | null;
          historicalTokenHashes: string[];
          userAgent: string | null;
          ipAddress: string | null;
          expiresAt: Date;
          revokedAt: Date | null;
          rotatedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
        }>
      >`
        SELECT * FROM "Session"
        WHERE "id" = ${decoded.sessionId}
        FOR UPDATE
      `;

      if (!rows || rows.length === 0) {
        throw new UnauthorizedError('Invalid or expired refresh token');
      }

      const session = rows[0];

      // Session validity checks
      if (session.revokedAt !== null || new Date(session.expiresAt) < new Date()) {
        throw new UnauthorizedError('Session has expired or been revoked');
      }

      const user = await tx.user.findUnique({
        where: { id: session.userId },
      });

      if (!user) {
        throw new UnauthorizedError('User not found');
      }

      const userPayload: AuthUserPayload = {
        id: user.id,
        username: user.username,
        email: user.email,
      };

      // Case A: Incoming token matches current active tokenHash -> atomic rotation
      if (session.tokenHash === incomingHash) {
        const newAccessToken = generateAccessToken(userPayload, session.id);
        const newRefreshToken = generateRefreshToken(userPayload, session.id);
        const newHash = hashToken(newRefreshToken);

        const currentHistory = Array.isArray(session.historicalTokenHashes)
          ? session.historicalTokenHashes
          : [];
        const updatedHistorical = [...currentHistory, session.tokenHash];

        await tx.session.update({
          where: { id: session.id },
          data: {
            tokenHash: newHash,
            previousTokenHash: session.tokenHash,
            historicalTokenHashes: updatedHistorical,
            rotatedAt: new Date(),
            userAgent: userAgent || session.userAgent,
            ipAddress: ipAddress || session.ipAddress,
          },
        });

        return {
          user: userPayload,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        };
      }

      // Case B: Incoming token matches previousTokenHash -> check 10s grace period for concurrent requests
      if (session.previousTokenHash === incomingHash) {
        const now = Date.now();
        const rotatedTime = session.rotatedAt
          ? new Date(session.rotatedAt).getTime()
          : 0;
        const isWithinGracePeriod = now - rotatedTime <= 10000;

        if (isWithinGracePeriod) {
          // Within grace period: mint fresh access token without minting competing refresh token
          const newAccessToken = generateAccessToken(userPayload, session.id);
          return {
            user: userPayload,
            accessToken: newAccessToken,
            refreshToken: null, // Client preserves existing active refresh token
          };
        }

        // Past grace period -> REUSE DETECTED! Revoke immediately and commit before throwing
        await tx.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });

        return { reuseDetected: true };
      }

      // Case C: Incoming token matches any historical token hash -> REUSE DETECTED! Revoke immediately and commit before throwing
      const isHistoricalReuse =
        Array.isArray(session.historicalTokenHashes) &&
        session.historicalTokenHashes.includes(incomingHash);

      if (isHistoricalReuse) {
        await tx.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });

        return { reuseDetected: true };
      }

      // Case D: Token does not match active, previous, or historical tokens for this session
      return { invalidToken: true };
    });

    if (result && 'reuseDetected' in result && (result as any).reuseDetected) {
      throw new UnauthorizedError(
        'Refresh token reuse detected. Compromised session has been revoked.'
      );
    }

    if ('invalidToken' in result && result.invalidToken) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    return result as {
      user: AuthUserPayload;
      accessToken: string;
      refreshToken: string | null;
    };
  }

  static async logout(refreshToken?: string, accessToken?: string) {
    try {
      // 1. If accessToken provided, revoke session immediately by its embedded sessionId
      if (accessToken) {
        const decodedAccess = verifyAccessToken(accessToken);
        if (decodedAccess?.sessionId) {
          await prisma.session.updateMany({
            where: {
              id: decodedAccess.sessionId,
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
        }
      }

      // 2. If refreshToken provided, revoke session by sessionId or token hashes
      if (refreshToken) {
        const decoded = verifyRefreshToken(refreshToken);
        const hashed = hashToken(refreshToken);

        if (decoded?.sessionId) {
          await prisma.session.updateMany({
            where: {
              id: decoded.sessionId,
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
        } else {
          await prisma.session.updateMany({
            where: {
              OR: [
                { tokenHash: hashed },
                { previousTokenHash: hashed },
                { historicalTokenHashes: { has: hashed } },
              ],
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
        }
      }
    } catch {
      // Ignore if session not found or invalid
    }
  }

  static async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    const [collectionsCount, pendingInvitationsCount] = await Promise.all([
      prisma.collection.count({
        where: {
          OR: [
            { ownerId: userId },
            { members: { some: { userId } } },
          ],
        },
      }),
      prisma.collaborationInvitation.count({
        where: {
          inviteeId: userId,
          status: 'PENDING',
        },
      }),
    ]);

    return {
      ...user,
      collectionsCount,
      pendingInvitationsCount,
    };
  }
}
