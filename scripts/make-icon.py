"""Rasterize the project's geometric vector mark without third-party dependencies."""
import math, struct, zlib
from pathlib import Path
size = 1024
segments = [(7,9,17,9),(17,9,17,23),(17,23,7,23),(7,23,7,9),(17,5,25,5),(25,5,25,19),(25,19,17,19),(17,19,17,5),(11,18,21,11)]
def distance(x,y,a,b,c,d):
    dx,dy=c-a,d-b
    t=max(0,min(1,((x-a)*dx+(y-b)*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-a-t*dx,y-b-t*dy)
rows=[]
for y in range(size):
    row=bytearray()
    for x in range(size):
        qx,qy=abs(x-512)-228,abs(y-512)-228
        edge=math.hypot(max(qx,0),max(qy,0))+min(max(qx,qy),0)-220
        alpha=max(0,min(255,round((0.5-edge)*255)))
        if not alpha: row.extend((0,0,0,0)); continue
        lx,ly=(x-64)/28,(y-64)/28
        white=max(0,min(1,(1.25-min(distance(lx,ly,*s) for s in segments))*28+0.5))
        row.extend((round(51+204*white),round(112+143*white),255,alpha))
    rows.append(b'\0'+row)
def chunk(name,data):
    return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b'')
Path(__file__).resolve().parents[1].joinpath('assets/icon.png').write_bytes(png)
