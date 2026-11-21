; Datum 설치 프로그램 (Inno Setup 6) — 내 PC 사용자 계정에만 설치(관리자 권한 불필요)
#define AppName "Datum"
#define AppVersion "0.4.0"

[Setup]
AppId={{5B3C8A1E-7C2D-4E59-9C0B-DA7A0D1A7E11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Personal
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=Output
OutputBaseFilename=Datum-Setup-{#AppVersion}
SetupIconFile=datum.ico
UninstallDisplayIcon={app}\Datum.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=yes

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕 화면에 바로 가기 만들기"; GroupDescription: "추가 작업:"
Name: "assoc"; Description: "STEP 파일(.step, .stp)을 Datum으로 열기"; GroupDescription: "파일 연결:"

[Files]
Source: "..\dist\Datum\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\Datum.exe"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\Datum.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\Datum.STEP"; ValueType: string; ValueData: "STEP 3D 모델"; Flags: uninsdeletekey; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\Datum.STEP\DefaultIcon"; ValueType: string; ValueData: "{app}\Datum.exe,0"; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\Datum.STEP\shell\open\command"; ValueType: string; ValueData: """{app}\Datum.exe"" ""%1"""; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\.step\OpenWithProgids"; ValueType: string; ValueName: "Datum.STEP"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
Root: HKCU; Subkey: "Software\Classes\.stp\OpenWithProgids"; ValueType: string; ValueName: "Datum.STEP"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc

[Run]
Filename: "{app}\Datum.exe"; Description: "Datum 실행"; Flags: nowait postinstall skipifsilent
