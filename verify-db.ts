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
  const providers = await prisma.provider.findMany();
  const models = await prisma.model.findMany();
  const connections = await prisma.modelProvider.findMany();
  
  console.log(`Providers in DB: ${providers.length}`);
  providers.forEach(p => console.log(` - ${p.name}`));
  
  console.log(`\nModels in DB: ${models.length}`);
  models.forEach(m => console.log(` - ${m.name}`));
  
  console.log(`\nModel-Provider Connections: ${connections.length}`);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
