#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

function hasCommand(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
}

function tryInstall(command, args) {
  try {
    execFileSync(command, args, { stdio: 'inherit' });

    return true;
  } catch {
    return false;
  }
}

if (hasCommand('jq')) {
  process.exit(0);
}

process.stdout.write('jq not found, attempting to install...\n');

const sys = platform();
let installed = false;

switch (sys) {
  case 'darwin':
    if (hasCommand('brew')) {
      installed = tryInstall('brew', ['install', 'jq']);
    }

    break;
  case 'linux':
    if (hasCommand('apt')) {
      installed = tryInstall('apt', ['install', '-y', 'jq']);
    } else if (hasCommand('dnf')) {
      installed = tryInstall('dnf', ['install', '-y', 'jq']);
    } else if (hasCommand('yum')) {
      installed = tryInstall('yum', ['install', '-y', 'jq']);
    } else if (hasCommand('apk')) {
      installed = tryInstall('apk', ['add', 'jq']);
    }

    break;
  case 'win32':
    if (hasCommand('winget')) {
      installed = tryInstall('winget', [
        'install',
        'jqlang.jq',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ]);
    } else if (hasCommand('choco')) {
      installed = tryInstall('choco', ['install', 'jq', '-y']);
    } else if (hasCommand('scoop')) {
      installed = tryInstall('scoop', ['install', 'jq']);
    }

    break;
}

if (!installed) {
  process.stderr.write(
    '\nWarning: Could not install jq automatically. It is required for Claude agent hooks.\nSee https://jqlang.org/download/ for install instructions.\n\n'
  );
}
