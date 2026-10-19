import { createInterface } from 'node:readline';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './password.js';

// The one way to make an admin: npm run admin:create -- asha@treeps.in Asha Verma (the name is every
// word after the email, so no quotes are needed; Windows mangles them). The password is
// typed at the prompt (hidden) or piped in on stdin; it is never an argument, so it never lands in
// shell history. In Express terms, a seed script you run by hand.
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text.replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const writer = rl as unknown as { _writeToOutput: (text: string) => void };
  return new Promise((resolve) => {
    process.stdout.write('Password (hidden): ');
    writer._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env file: the variables must already be set
  }
  const [emailArg, ...nameWords] = process.argv.slice(2);
  const name = nameWords.join(' ');
  const email = emailArg?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name?.trim()) {
    console.error('Usage: npm run admin:create -- <email> <name words>');
    process.exit(1);
  }
  const password = await readPassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    if (await prisma.admin.findUnique({ where: { email } })) {
      console.error('An admin with this email already exists.');
      process.exit(1);
    }
    const admin = await prisma.admin.create({ data: { email, name: name.trim(), passwordHash: await hashPassword(password) } });
    console.log(`Admin created: ${admin.email} (${admin.id})`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  console.error('Could not create the admin:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
