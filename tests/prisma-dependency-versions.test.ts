import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

console.log('--- Task C2: Strict Prisma Version Alignment Test ---');

// 1. Check package.json exact strings (no ^ or ~)
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

const prismaVer = deps['prisma'];
const clientVer = deps['@prisma/client'];
const libsqlVer = deps['@prisma/adapter-libsql'];

assert.equal(prismaVer, '7.8.0', 'package.json prisma version must be exactly 7.8.0');
assert.equal(clientVer, '7.8.0', 'package.json @prisma/client version must be exactly 7.8.0');
assert.equal(libsqlVer, '7.8.0', 'package.json @prisma/adapter-libsql version must be exactly 7.8.0');
console.log('  pass: package.json exact versions verified (7.8.0)');

// 2. Check package-lock.json resolved versions
const lock = JSON.parse(readFileSync('./package-lock.json', 'utf8'));

function getLockVersion(pkgName: string): string {
  const entry = lock.packages[`node_modules/${pkgName}`];
  assert.ok(entry, `package-lock.json must contain node_modules/${pkgName}`);
  return entry.version;
}

const lockPrisma = getLockVersion('prisma');
const lockClient = getLockVersion('@prisma/client');
const lockLibsql = getLockVersion('@prisma/adapter-libsql');

assert.equal(lockPrisma, '7.8.0', 'package-lock.json prisma version must be 7.8.0');
assert.equal(lockClient, '7.8.0', 'package-lock.json @prisma/client version must be 7.8.0');
assert.equal(lockLibsql, '7.8.0', 'package-lock.json @prisma/adapter-libsql version must be 7.8.0');
console.log('  pass: package-lock.json resolved versions verified (7.8.0)');

// 3. Check installed node_modules package.json files
function getInstalledVersion(pkgName: string): string {
  const pPath = path.join('node_modules', pkgName, 'package.json');
  assert.ok(existsSync(pPath), `Installed package.json must exist at ${pPath}`);
  const installedPkg = JSON.parse(readFileSync(pPath, 'utf8'));
  return installedPkg.version;
}

const installedPrisma = getInstalledVersion('prisma');
const installedClient = getInstalledVersion('@prisma/client');
const installedLibsql = getInstalledVersion('@prisma/adapter-libsql');

assert.equal(installedPrisma, '7.8.0', 'Installed prisma version must be 7.8.0');
assert.equal(installedClient, '7.8.0', 'Installed @prisma/client version must be 7.8.0');
assert.equal(installedLibsql, '7.8.0', 'Installed @prisma/adapter-libsql version must be 7.8.0');
console.log('  pass: Installed node_modules versions verified (7.8.0)');

console.log('All Task C2 version assertions passed!');
