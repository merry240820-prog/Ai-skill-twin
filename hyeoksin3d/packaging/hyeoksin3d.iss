; 혁신3D 설치 프로그램 (Inno Setup 6) — 내 PC 사용자 계정에만 설치(관리자 권한 불필요)
#define AppName "혁신3D"
#define ExeName "Hyeoksin3D.exe"
#define AppVersion "0.6.0"

[Setup]
AppId={{8E2F4B6A-3D1C-4F7E-A9B2-6C5D0E1F3A72}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Personal
DefaultDirName={localappdata}\Programs\Hyeoksin3D
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=Output
OutputBaseFilename=Hyeoksin3D-Setup-{#AppVersion}
SetupIconFile=hyeoksin3d.ico
UninstallDisplayIcon={app}\{#ExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=yes

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕 화면에 바로 가기 만들기"; GroupDescription: "추가 작업:"
Name: "assoc"; Description: "STEP 파일(.step, .stp)을 혁신3D로 열기"; GroupDescription: "파일 연결:"

[Files]
Source: "..\dist\Hyeoksin3D\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#ExeName}"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\Hyeoksin3D.STEP"; ValueType: string; ValueData: "STEP 3D 모델"; Flags: uninsdeletekey; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\Hyeoksin3D.STEP\DefaultIcon"; ValueType: string; ValueData: "{app}\{#ExeName},0"; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\Hyeoksin3D.STEP\shell\open\command"; ValueType: string; ValueData: """{app}\{#ExeName}"" ""%1"""; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\.step\OpenWithProgids"; ValueType: string; ValueName: "Hyeoksin3D.STEP"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\.stp\OpenWithProgids"; ValueType: string; ValueName: "Hyeoksin3D.STEP"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc

[Run]
Filename: "{app}\{#ExeName}"; Description: "혁신3D 실행"; Flags: nowait postinstall skipifsilent
