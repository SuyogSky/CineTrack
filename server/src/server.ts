import { app } from './app';
import { env } from './config/env';
import { disconnectDatabase, prisma } from './config/database';

function validateNodeVersion() {
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  const isValid =
    (major === 20 && minor >= 19) ||
    (major === 22 && minor >= 12) ||
    (major >= 24);
  if (!isValid) {
    console.error(
      `❌ Incompatible Node.js runtime version "${version}". CineTrack requires Node.js >=20.19.0, >=22.12.0, or >=24.0.0.`
    );
    process.exit(1);
  }
}
validateNodeVersion();

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  try {
    await prisma.$connect();
    console.log(`🎬 CineTrack Server running at http://localhost:${env.PORT}`);
    console.log(`📡 Environment: ${env.NODE_ENV}`);
    console.log(`🔒 Security headers and CORS active`);
  } catch (error) {
    console.error('❌ Failed to connect to database on startup:', error);
    process.exit(1);
  }
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);
  server.close(async () => {
    console.log('🔌 HTTP server closed.');
    try {
      await disconnectDatabase();
      console.log('💾 Database connection pool terminated.');
      process.exit(0);
    } catch (err) {
      console.error('Error during database disconnect:', err);
      process.exit(1);
    }
  });

  // Force exit if not cleanly shut down within 10s
  setTimeout(() => {
    console.error('⚠️ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default server;
