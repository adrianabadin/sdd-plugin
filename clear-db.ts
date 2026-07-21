import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, 'opencode-models.db');
process.env.DATABASE_URL = `file:${dbPath}`;

const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.modelProviderPricing.deleteMany();
  await prisma.modelProvider.deleteMany();
  await prisma.model.deleteMany();
  await prisma.provider.deleteMany();
  console.log("Database cleared.");
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
