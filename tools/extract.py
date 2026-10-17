#!/usr/bin/env python3
"""Pull the tables, strings and inventory art this site needs out of a local D2R install.

    CASCLIB=/path/to/libcasc.so python3 tools/extract.py [GAME_DIR]

Writes raw/ (tables + strings + HD asset maps) and public/img/ (inventory sprites as webp).
Both are committed, so the site builds without the game.
"""
import io
import json
import os
import shutil
import struct
import sys

from PIL import Image

from casc import Storage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_GAME = os.path.expanduser('~/.local/share/Steam/steamapps/common/Diablo II Resurrected')
RAW = os.path.join(ROOT, 'raw')
IMG = os.path.join(ROOT, 'public', 'img')


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)


def top_level(storage, mask, prefix):
    """Files directly under `prefix` (not in subfolders) matching `mask`."""
    for name in storage.find(mask):
        rel = name.split(prefix, 1)[1]
        if '\\' not in rel:
            yield name, rel


# Exactly what d2itemtoolkit's loader reads (D2DataFiles.dataFileNames).
EXCEL = {
    'armor', 'automagic', 'belts', 'charstats', 'colors', 'cubemain', 'elemtypes', 'experience', 'gems',
    'itemstatcost', 'itemtypes', 'lowqualityitems', 'magicprefix', 'magicsuffix', 'misc', 'missiles',
    'monmode', 'monstats', 'monstats2', 'montype', 'playerclass', 'plrmode', 'plrtype', 'properties',
    'propertygroups', 'qualityitems', 'rareprefix', 'raresuffix', 'runes', 'setitems', 'sets', 'skilldesc',
    'skills', 'states', 'uniqueitems', 'weapons',
}
STRINGS = {
    'bnet', 'commands', 'item-gems', 'item-modifiers', 'item-nameaffixes', 'item-names', 'item-runes',
    'keybinds', 'levels', 'mercenaries', 'monsters', 'npcs', 'objects', 'quests', 'shrines', 'skills',
    'ui-controller', 'ui',
}


def english_only(data):
    rows = json.loads(data.decode('utf-8-sig'))
    rows = [{'id': r['id'], 'Key': r['Key'], 'enUS': r.get('enUS', '')} for r in rows]
    return json.dumps(rows, ensure_ascii=False, indent=0).encode('utf-8')


def sprite_to_webp(data):
    # SpA1: magic, u16 version, u16 frame width, u32 width, u32 height, ..., u32 frames @0x14,
    # then RGBA8 pixels at 0x28. Multi-frame sprites lay frames side by side; keep the first.
    if data[:4] != b'SpA1':
        raise ValueError('not a SpA1 sprite')
    frame_w, width, height = struct.unpack_from('<HII', data, 6)
    img = Image.frombytes('RGBA', (width, height), data[0x28:0x28 + width * height * 4])
    if frame_w and frame_w < width:
        img = img.crop((0, 0, frame_w, height))
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    out = io.BytesIO()
    img.save(out, 'WEBP', quality=88, method=6)
    return out.getvalue()


def main():
    game = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GAME
    s = Storage(game)

    shutil.rmtree(RAW, ignore_errors=True)
    shutil.rmtree(IMG, ignore_errors=True)

    n = 0
    for name, rel in top_level(s, 'data:data\\global\\excel\\*.txt', 'excel\\'):
        if rel.lower()[:-4] in EXCEL:
            write(os.path.join(RAW, 'excel', rel.lower()), s.read(name))
            n += 1
    for d in ('strings', 'strings-legacy'):
        for name, rel in top_level(s, f'data:data\\local\\lng\\{d}\\*.json', d + '\\'):
            if rel[:-5] in STRINGS:
                write(os.path.join(RAW, d, rel), english_only(s.read(name)))
                n += 1
    write(os.path.join(RAW, 'global', 'animdata.d2'), s.read('data:data\\global\\animdata.d2'))
    for m in ('items', 'uniques', 'sets'):
        write(os.path.join(RAW, 'hd', m + '.json'), s.read(f'data:data\\hd\\items\\{m}.json'))
        n += 1
    print(f'{n} data files')

    # Inventory art. HD asset names ("helmet/cap_hat") are relative to ui\items\<category>\.
    # The .lowend variant is 98px per inventory cell, plenty for a card.
    n = 0
    prefix = 'data:data\\hd\\global\\ui\\items\\'
    for name in s.find(prefix + '*.lowend.sprite'):
        rel = name[len(prefix):].split('\\', 1)[1]  # drop weapon\ / armor\ / misc\
        asset = rel[:-len('.lowend.sprite')].replace('\\', '/').lower()
        try:
            write(os.path.join(IMG, asset + '.webp'), sprite_to_webp(s.read(name)))
            n += 1
        except ValueError as e:
            print('skip', name, e)
    print(f'{n} sprites')


if __name__ == '__main__':
    main()
