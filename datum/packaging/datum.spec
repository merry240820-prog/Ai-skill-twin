# PyInstaller 빌드 설정 — Windows 11용 Datum.exe (폴더형 배포)
# 사용: (datum 폴더에서) pyinstaller --noconfirm packaging/datum.spec
import glob
import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
SITE = next(p for p in sys.path if p.endswith("site-packages"))

binaries = []
datas = [(os.path.join(ROOT, "web"), "web"), (os.path.join(ROOT, "samples"), "samples")]

# OpenCascade(OCP): 본체 .pyd + delvewheel이 묶은 DLL 폴더
binaries += collect_dynamic_libs("OCP")
for libs in glob.glob(os.path.join(SITE, "cadquery_ocp*.libs")):
    for f in glob.glob(os.path.join(libs, "*")):
        binaries.append((f, os.path.basename(libs)))
# OCP가 링크하는 VTK DLL
binaries += collect_dynamic_libs("vtkmodules", destdir="vtkmodules")
for libs in glob.glob(os.path.join(SITE, "vtk*.libs")):
    for f in glob.glob(os.path.join(libs, "*")):
        binaries.append((f, os.path.basename(libs)))
# gmsh: gmsh.py는 자기 옆(또는 상위 폴더)의 gmsh-x.y.dll을 찾는다 → 실행 폴더 루트에 둔다
for pattern in [os.path.join(sys.prefix, "Lib", "gmsh*.dll"), os.path.join(SITE, "gmsh*.dll"), os.path.join(sys.prefix, "Lib", "site-packages", "gmsh*.dll"),
                os.path.join(sys.prefix, "gmsh*.dll"), os.path.join(sys.prefix, "Library", "bin", "gmsh*.dll")]:
    for f in glob.glob(pattern):
        binaries.append((f, "."))
datas += collect_data_files("reportlab") + collect_data_files("ezdxf") + collect_data_files("webview")

hidden = (collect_submodules("uvicorn") + collect_submodules("pyamg") + collect_submodules("ezdxf")
          + collect_submodules("reportlab") + collect_submodules("webview") + ["gmsh", "scipy.sparse.linalg", "server"])

a = Analysis(
    [os.path.join(ROOT, "desktop.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "PyQt5", "PyQt6", "PySide2", "PySide6", "IPython", "pytest", "vtk"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Datum",
    icon=os.path.join(SPECPATH, "datum.ico"),
    console=False,
    version=os.path.join(SPECPATH, "version.txt"),
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Datum", upx=False)
