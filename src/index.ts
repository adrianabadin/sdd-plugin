/**
 * Main entrypoint for the OpenCode Plugin.
 * Intercepts `task` execution to take control of the workflow.
 */
import { Logger } from './logger.js';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../opencode-models.db');

// Inject the absolute path to the SQLite db into env for Prisma
process.env.DATABASE_URL = `file:${dbPath}`;

const prisma = new PrismaClient();

export const SddPlugin = async (ctx: any) => {
  const { project, client, directory, worktree } = ctx;
  const logger = new Logger(project, directory);
  
  logger.info("Plugin loaded. Syncing connected models to SQLite...");

  try {
    // Get the list of connected models from OpenCode SDK
    const models = typeof client.provider?.list === 'function' 
      ? await client.provider.list() 
      : typeof client.models?.list === 'function'
        ? await client.models.list()
        : [];

    logger.info(`Found ${models?.length || 0} models connected. Upserting into normalized DB...`);

    for (const rawModel of models || []) {
      const rawId = rawModel.id || rawModel.name || "unknown-id";
      const modelName = rawModel.name || rawId;
      
      // Normalize provider and model ID
      const parts = rawId.split('/');
      const providerId = rawModel.provider || parts[0] || "unknown";
      const modelId = parts.length > 1 ? parts.slice(1).join('/') : rawId;

      // 1. Upsert Provider
      await prisma.provider.upsert({
        where: { id: providerId },
        update: {
          name: providerId,
          updatedAt: new Date()
        },
        create: {
          id: providerId,
          name: providerId,
        }
      });

      // 2. Upsert Model
      await prisma.model.upsert({
        where: { id: modelId },
        update: {
          name: modelName,
          updatedAt: new Date()
        },
        create: {
          id: modelId,
          name: modelName,
        }
      });

      // 3. Upsert ModelProvider link
      await prisma.modelProvider.upsert({
        where: {
          modelId_providerId: {
            modelId,
            providerId
          }
        },
        update: {},
        create: {
          modelId,
          providerId
        }
      });
    }
    
    logger.info("Model sync complete.");
  } catch (error) {
    logger.error("Failed to sync models to DB", error);
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      // Intercept the `task` tool to take control of the workflow/subagent spawning
      if (input.tool === "task") {
        logger.info(`Intercepting task: ${output.args?.subagent_type || 'unknown'}`);
        
        if (output.args?.subagent_type) {
           // We can query the SQLite DB here to decide model allocation 
           // based on benchmarks and quarantine status
        }
      }
    }
  };
};

export default SddPlugin;
