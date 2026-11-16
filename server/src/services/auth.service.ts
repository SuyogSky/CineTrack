import { prisma } from '../config/database';
import { hashPassword, verifyPassword } from '../utils/password';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
} from '../utils/jwt';
import { RegisterInput, LoginInput } from '../validators/auth.validator';
import { AppError, ConflictError, UnauthorizedError } from '../utils/errors';
import { AuthUserPayload } from '../types';

export class AuthService {
  static async register(input: RegisterInput, userAgent?: string, ipAddress?: string) {
    const normalizedEmail = input.email.toLowerCase().trim();
    const normalizedUsername = input.username.trim();

    // Check existing user
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { username: normalizedUsername }],
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
    const user = await prisma.$transaction(async (tx) => {
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

    const userPayload: AuthUserPayload = {
      id: user.id,
      username: user.username,
      email: user.email,
    };

    // Create initial session
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Initial dummy hash placeholder to get ID
    const initialSession = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: `init-${user.id}-${Date.now()}-${Math.random()}`,
        userAgent,
        ipAddress,
        expiresAt,
      },
    });

    const accessToken = generateAccessToken(userPayload);
    const refreshToken = generateRefreshToken(userPayload, initialSession.id);
    const hashedRefreshToken = hashToken(refreshToken);

    await prisma.session.update({
      where: { id: initialSession.id },
      data: { tokenHash: hashedRefreshToken },
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
        ? { email: identifier.toLowerCase() }
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
      await prisma.collection.create({
        data: {
          ownerId: user.id,
          title: 'My Watchlist',
          description: 'Personal master watchlist for movies to watch.',
          visibility: 'PRIVATE',
          isDefaultWatchlist: true,
        },
      });
    }

    const userPayload: AuthUserPayload = {
      id: user.id,
      username: user.username,
      email: user.email,
    };

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const initialSession = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: `init-${user.id}-${Date.now()}-${Math.random()}`,
        userAgent,
        ipAddress,
        expiresAt,
      },
    });

    const accessToken = generateAccessToken(userPayload);
    const refreshToken = generateRefreshToken(userPayload, initialSession.id);
    const hashedRefreshToken = hashToken(refreshToken);

    await prisma.session.update({
      where: { id: initialSession.id },
      data: { tokenHash: hashedRefreshToken },
    });

    return {
      user: userPayload,
      accessToken,
      refreshToken,
    };
  }

  static async logout(refreshToken?: string) {
    if (!refreshToken) return;
    try {
      const hashed = hashToken(refreshToken);
      await prisma.session.updateMany({
        where: { tokenHash: hashed, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Ignore if session not found
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
