"""Draw the branded share cover using the original logo, without company data."""
from pathlib import Path
import sys
MEMBER = "--member" in sys.argv
from PIL import Image, ImageDraw, ImageFont
ROOT = Path(__file__).resolve().parents[1]
FONT = '/System/Library/Fonts/STHeiti Medium.ttc'
W, H = 1000, 800
im = Image.new('RGB', (W,H)); d = ImageDraw.Draw(im)
for y in range(H):
    t=y/H
    d.line((0,y,W,y),fill=(int(15+9*t),int(48+42*t),int(104+54*t)))
for r in (260,330,400):
    d.ellipse((940-r,-70-r,940+r,-70+r),outline='#316caf',width=2)
d.rounded_rectangle((48,44,952,756),radius=30,fill='#f7faff')
d.rounded_rectangle((66,62,934,738),radius=22,outline='#dbe6f3',width=2)
logo=Image.open(ROOT/'miniprogram/images/logo.png').convert('RGBA').resize((88,88),Image.Resampling.LANCZOS)
im.paste(logo,(100,100),logo)
def text(x,y,s,size,color):
    d.text((x,y),s,font=ImageFont.truetype(FONT,size),fill=color)
text(208,103,'商签通',36,'#163c68')
text(210,151,'TradePass',22,'#8193aa')
text(694,125,'诚 挚 邀 请',24,'#4678ab')
d.line((100,220,900,220),fill='#dce6f1',width=2)
text(100,266,'组织成员邀请函' if MEMBER else '企业合作邀请函',66,'#143964')
text(104,359,'邀请您加入团队，让协作更高效' if MEMBER else '携手合作，让每一笔往来更高效',31,'#657e98')
d.rounded_rectangle((100,440,900,549),radius=18,fill='#eaf2fb')
for x,label,sub in ([(134,'加入组织','连接团队'),(391,'分配角色','明确职责'),(649,'协同办公','同步进展')] if MEMBER else [(134,'采购协同','连接供需'),(391,'合同签署','确认合作'),(649,'业务往来','同步进展')]):
    text(x,461,label,28,'#266cb2');text(x,502,sub,21,'#8295ab')
d.rounded_rectangle((100,603,900,678),radius=18,fill='#2385e6')
text(304,623,'查看邀请 · 申请加入' if MEMBER else '查看邀请 · 建立合作',30,'#ffffff')
text(303,701,'提交加入申请，等待管理员审核' if MEMBER else '以各自企业身份，开启合作',22,'#8a9db2')
# Indexed PNG keeps bundled share covers small without reducing dimensions.
im.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(ROOT/('miniprogram/images/member-invite-cover.png' if MEMBER else 'miniprogram/images/company-invite-cover.png'),optimize=True)
