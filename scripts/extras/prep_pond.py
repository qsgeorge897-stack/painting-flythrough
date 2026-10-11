"""Monet example - lily-pond surface (Water Lilies 1906) for ?cut=fusion / fusion2. Needs img/lilies.jpg.
    python3 scripts/extras/prep_pond.py
"""
import numpy as np, cv2, json
OUT="web/data"
img=cv2.cvtColor(cv2.imread("img/lilies.jpg"),cv2.COLOR_BGR2RGB)
img=cv2.resize(img,(2048,1971),interpolation=cv2.INTER_AREA)
# crop the signature corner out by mirroring the bottom-right? keep simple: use as is
cv2.imwrite(f"{OUT}/pond.jpg",cv2.cvtColor(img,cv2.COLOR_RGB2BGR),[cv2.IMWRITE_JPEG_QUALITY,93])
f=img.astype(np.float32)/255
r,g,b=f[...,0],f[...,1],f[...,2]
pad=np.clip((g-b)*3.0+0.35,0,1)          # green/yellow pads stand out from blue water
pink=np.clip((r-b)*2.5,0,1)               # flowers
m=np.maximum(pad,pink)
m=cv2.GaussianBlur(m,(0,0),3)
lum=cv2.cvtColor(img,cv2.COLOR_RGB2GRAY).astype(np.float32)/255
hp=cv2.GaussianBlur(lum,(0,0),1.5)-cv2.GaussianBlur(lum,(0,0),9)
h=np.clip(0.75*m+0.25*(hp/np.abs(hp).max()*0.5+0.5),0,1)
hs=cv2.GaussianBlur(h,(0,0),1.2)
nx=cv2.Sobel(hs,cv2.CV_32F,1,0,ksize=3); ny=cv2.Sobel(hs,cv2.CV_32F,0,1,ksize=3)
s=9.0; n=np.stack([-nx*s,ny*s,np.ones_like(nx)],-1); n/=np.linalg.norm(n,axis=-1,keepdims=True)
cv2.imwrite(f"{OUT}/pond_n.png",cv2.cvtColor(((n*0.5+0.5)*255).astype(np.uint8),cv2.COLOR_RGB2BGR))
G=641
hg=cv2.resize(cv2.GaussianBlur(h,(0,0),2.5),(G,G),interpolation=cv2.INTER_AREA).astype(np.float32)
hg.tofile(f"{OUT}/pond_h.bin"); json.dump(dict(G=G,aspect=1971/2048),open(f"{OUT}/pond.json","w"))
print("ok",h.mean())
