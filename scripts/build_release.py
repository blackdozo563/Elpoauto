#!/usr/bin/env python3
"""Build a Mac test package using the verified 0.3.1 package as runtime input."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import zipfile
from pack_asar import build, verify

def package(base, output, test_report):
    source = pathlib.Path(__file__).resolve().parents[1]
    base, output, test_report = map(lambda p: pathlib.Path(p).resolve(), (base, output, test_report))
    version = json.loads((source / 'package.json').read_text())['version']
    release = output / ('ElpoAiAutoCapcut-' + version)
    if release.exists():
        raise SystemExit('Output already exists; use a new output directory.')
    # Preserve verification before reusing the supplied runtime and helper scripts.
    for line in (base / 'payload/checksums.txt').read_text().splitlines():
        expected, name = line.split(maxsplit=1)
        file = (base / name).resolve()
        if not file.is_relative_to(base) or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise SystemExit('Invalid input checksum: ' + name)
    release.mkdir(parents=True)
    for folder in ('payload', 'runtime', 'Exemple-essai'):
        shutil.copytree(base / folder, release / folder)
    shutil.copytree(source, release / 'sources', ignore=shutil.ignore_patterns('.git', 'dist', 'node_modules', '__pycache__', '*.log'))
    for name in ('Installer-ElpoAiAutoCapcut.command', 'Diagnostiquer-ElpoAiAutoCapcut.command'):
        text = (base / name).read_text().replace('0.3.1', version)
        (release / name).write_text(text)
        (release / name).chmod(0o755)
    subprocess.run(['bash', '-n', str(release / 'Installer-ElpoAiAutoCapcut.command')], check=True)
    shutil.copy2(source / 'README.md', release / 'LISEZ-MOI.md')
    shutil.copy2(source / 'ATTRIBUTION.md', release / 'ATTRIBUTION.md')
    shutil.copy2(test_report, release / 'resultats-tests.txt')
    header_hash = build(source, release / 'payload/app.asar')
    (release / 'payload/header.sha256').write_text(header_hash + '\n')
    count = verify(release / 'payload/app.asar', source)
    (release / 'VALIDATION.md').write_text(
        f'# Validation {version}\n\n'
        'Résultats de la suite Node joints dans resultats-tests.txt. '
        'Les tests utilisent des projets synthétiques et un DOM simulé.\n\n'
        f'ASAR : {count} fichiers comparés aux sources et empreintes vérifiées. '
        'Syntaxe Bash de l’installateur vérifiée.\n\n'
        'Installation, lancement natif, décodage Electron et rendu CapCut non testés sur Mac. '
        'Essayer sur une copie de projet avec timeline vide et voix off importée. '
        'Aucun export vidéo ni export en lot dans cette version.\n')
    paths = [p.relative_to(release).as_posix() for p in sorted((release / 'payload').iterdir()) if p.name != 'checksums.txt']
    paths += ['runtime/TryAIToday.AutoCapCut-0.1.2-arm64.dmg']
    (release / 'payload/checksums.txt').write_text(''.join(hashlib.sha256((release / p).read_bytes()).hexdigest() + '  ' + p + '\n' for p in paths))
    archive = output / ('ElpoAiAutoCapcut-' + version + '-Mac-AppleSilicon.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for file in sorted(release.rglob('*')):
            if file.is_file():
                z.write(file, file.relative_to(output))
    with zipfile.ZipFile(archive) as z:
        if z.testzip(): raise SystemExit('ZIP integrity error')
    print(archive)
    print('SHA256:', hashlib.sha256(archive.read_bytes()).hexdigest())

if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: build_release.py ORIGINAL_PACKAGE OUTPUT_DIRECTORY TEST_REPORT')
    package(*sys.argv[1:])
