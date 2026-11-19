"""Run all local regression layers once. Never deploys or sends provider messages.

Requires the existing backend venv, Node/Firebase CLI and cached temporary Java.
All Java/Firebase emulator settings apply only to child processes.
"""
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', type=int, choices=(4, 5), default=4, help='Evidence label; all regression layers still run.')
    phase = parser.parse_args().phase
    evidence_dir = ROOT / '.nampol'; evidence_dir.mkdir(exist_ok=True)
    protected = ['firestore.rules', 'storage.rules', 'firebase.json']
    hashes = lambda paths: {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in paths}
    before = hashes(protected)
    env = os.environ.copy()
    # Providers cannot be selected by inherited developer mail settings.
    env['NAMPOL_EMAIL_MODE'] = 'preview'
    env.pop('NAMPOL_APPROVED_EMAIL_DELIVERY', None)
    env.pop('DEBUG', None)
    for name in ('FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'NAMPOL_LIVE_CLAMAV_TEST'):
        env.pop(name, None)
    js = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('*.test.cjs') if p.name != 'firestore-security.test.cjs')
    emulator_env = env.copy()
    tools = Path(os.environ['TEMP']) / 'nampol-firestore-test-tools'
    java = tools / 'jdk-21.0.12.1+1-jre'
    if not (java / 'bin/java.exe').is_file():
        raise SystemExit('Cached temporary Java is missing. No system settings were changed.')
    emulator_env.update(JAVA_HOME=str(java), PATH=str(java / 'bin') + os.pathsep + env['PATH'],
                        FIREBASE_EMULATORS_PATH=str(tools / 'emulators'),
                        XDG_CONFIG_HOME=str(Path(os.environ['TEMP']) / 'nampol-firebase-validation'), CI='true')
    stages = [
        ('python', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], env),
        ('javascript', ['node', '--experimental-vm-modules', '--test', '--test-isolation=none', *js], env),
        ('firestore_emulator', ['cmd.exe', '/d', '/c', 'firebase.cmd', 'emulators:exec', '--only', 'firestore',
            '--project', 'demo-nampol-security', '--config', 'firebase.security-tests.json',
            'node --test --test-isolation=none tests/firestore-security.test.cjs'], emulator_env),
        ('launcher', ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            'tests/start_nampol.test.ps1', '-SkipFullLaunch'], env)
    ]
    results = {}
    for name, command, stage_env in stages:
        log = evidence_dir / f'phase{phase}-{name}-results.log'
        print(f'Running {name}; log: {log.relative_to(ROOT)}', flush=True)
        with log.open('w', encoding='utf-8') as output:
            process = subprocess.run(command, cwd=ROOT, env=stage_env, stdout=output, stderr=subprocess.STDOUT, timeout=600)
        text = log.read_text(encoding='utf-8')
        entry = {'exit_code': process.returncode, 'log': log.relative_to(ROOT).as_posix()}
        if name == 'python':
            count = re.search(r'Ran (\d+) tests?', text)
            skip = re.search(r'skipped=(\d+)', text)
            failures = re.search(r'failures=(\d+)', text); errors = re.search(r'errors=(\d+)', text)
            entry.update(collected=int(count[1]) if count else None, skipped=int(skip[1]) if skip else 0,
                         failed=(int(failures[1]) if failures else 0) + (int(errors[1]) if errors else 0))
            entry['passed'] = entry['collected'] - entry['skipped'] - entry['failed'] if count else None
        elif name in ('javascript', 'firestore_emulator'):
            for key in ('pass', 'fail', 'skipped'):
                matches = re.findall(r'(?:# |ℹ )' + key + r'\s+(\d+)', text)
                entry[{'pass': 'passed', 'fail': 'failed'}.get(key, key)] = int(matches[-1]) if matches else None
        else:
            entry.update(offline_check_groups_passed=len(re.findall(r'^PASS:', text, re.M)),
                         full_restart='SKIPPED - preserve existing processes')
        results[name] = entry
        print(json.dumps({name: entry}), flush=True)
    changed = before != hashes(protected)
    sources = [str(p.relative_to(ROOT)).replace('\\', '/') for directory in ('backend', 'js', 'Frontend', 'tests', 'scripts', 'demo')
               for p in (ROOT / directory).rglob('*') if p.is_file() and p.suffix in ('.py', '.js', '.cjs', '.html', '.ps1', '.json')]
    sources = [name for name in sources if not (name.startswith('demo/') and name.endswith('_evidence.json'))]
    sources += ['app.py', *protected, 'requirements.txt']
    evidence = {'recorded_at_utc': datetime.now(timezone.utc).isoformat(), 'phase': phase,
        'scope': 'LOCAL_COMPOSITION_AND_EMULATOR; NOT_LIVE_PROVIDER_OR_BROWSER_E2E',
        'firebase_sms_configuration': 'PENDING', 'smtp_delivery': 'PENDING',
        'real_sms_or_emails_sent': False, 'live_accounts_created': False, 'genuine_records_changed': False,
        'deployed': False, 'billing_changed': False, 'pushed': False,
        'protected_configuration_changed_during_suite': changed, **results,
        'source_sha256': hashes(sorted(set(sources)))}
    (evidence_dir / f'phase{phase}-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    raise SystemExit(1 if changed or any(row['exit_code'] for row in results.values()) else 0)


if __name__ == '__main__': main()
