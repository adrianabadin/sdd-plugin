import * as generatedModule from "../../generated/prisma/client.js";
import type { PrismaClient as GeneratedPrismaClient } from "../../generated/prisma/client.js";

type PrismaClientConstructor = new (...args: any[]) => GeneratedPrismaClient;

const runtimeModule = generatedModule as unknown as {
  readonly PrismaClient?: PrismaClientConstructor;
  readonly default?: { readonly PrismaClient?: PrismaClientConstructor };
};

export const PrismaClient =
  runtimeModule.default?.PrismaClient ?? runtimeModule.PrismaClient!;

export type PrismaClient = GeneratedPrismaClient;
