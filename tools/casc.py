"""Minimal ctypes wrapper over CascLib (https://github.com/ladislav-zezula/CascLib).

Point CASCLIB at a built libcasc.so (or put it next to this file).
"""
import ctypes
import os

_lib_path = os.environ.get('CASCLIB') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'libcasc.so')
L = ctypes.CDLL(_lib_path)
L.CascFindFirstFile.restype = ctypes.c_void_p


class FindData(ctypes.Structure):
    _fields_ = [
        ('szFileName', ctypes.c_char * 1024),
        ('CKey', ctypes.c_ubyte * 16),
        ('EKey', ctypes.c_ubyte * 16),
        ('TagBitMask', ctypes.c_uint64),
        ('FileSize', ctypes.c_uint64),
        ('szPlainName', ctypes.c_char_p),
        ('dwFileDataId', ctypes.c_uint32),
        ('dwLocaleFlags', ctypes.c_uint32),
        ('dwContentFlags', ctypes.c_uint32),
        ('dwSpanCount', ctypes.c_uint32),
        ('bFileAvailable', ctypes.c_uint32),
        ('NameType', ctypes.c_int),
        ('_pad', ctypes.c_ubyte * 64),
    ]


class Storage:
    def __init__(self, game_dir):
        self.h = ctypes.c_void_p()
        if not L.CascOpenStorage(game_dir.encode(), 0, ctypes.byref(self.h)):
            raise RuntimeError(f'CascOpenStorage failed for {game_dir}')

    def find(self, mask='*'):
        fd = FindData()
        hf = L.CascFindFirstFile(self.h, mask.encode(), ctypes.byref(fd), None)
        if not hf:
            return
        hf = ctypes.c_void_p(hf)
        try:
            while True:
                yield fd.szFileName.decode(errors='replace')
                if not L.CascFindNextFile(hf, ctypes.byref(fd)):
                    break
        finally:
            L.CascFindClose(hf)

    def read(self, name):
        f = ctypes.c_void_p()
        if not L.CascOpenFile(self.h, name.encode(), 0, 0, ctypes.byref(f)):
            raise FileNotFoundError(name)
        try:
            size = ctypes.c_uint64()
            L.CascGetFileSize64(f, ctypes.byref(size))
            buf = ctypes.create_string_buffer(size.value)
            n = ctypes.c_uint32()
            L.CascReadFile(f, buf, size.value, ctypes.byref(n))
            return buf.raw[:n.value]
        finally:
            L.CascCloseFile(f)
