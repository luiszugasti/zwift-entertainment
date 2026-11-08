#!/bin/zsh
# Builds a "RideReel" app for this Mac and adds it to the Dock.
#
# Clicking it starts RideReel from this repo (npm start) if it isn't already running, then opens
# http://localhost:5173. Run again after moving the repo. Usage:
#
#   scripts/install-mac-app.sh            # install to ~/Applications and add to the Dock
#   scripts/install-mac-app.sh --no-dock  # install only
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/RideReel.app"
ADD_TO_DOCK=1
[[ "${1:-}" == "--no-dock" ]] && ADD_TO_DOCK=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Building $APP for $REPO"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- launcher ---------------------------------------------------------------
cat > "$APP/Contents/MacOS/RideReel" <<EOF
#!/bin/zsh -l
# Login shell so Node from fnm/nvm/Homebrew is on PATH, as in Terminal.
export PATH="\$PATH:\$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin"
REPO="$REPO"
URL="http://localhost:5173"
LOG="\$HOME/Library/Logs/RideReel.log"

fail() {
  osascript -e "display alert \"RideReel didn't start\" message \"\$1\" as critical" >/dev/null
  exit 1
}

# Already running: just open it.
if curl -s -o /dev/null "\$URL"; then
  open "\$URL"
  exit 0
fi

[[ -d "\$REPO" ]] || fail "Couldn't find the project at \$REPO. Run scripts/install-mac-app.sh again from the repo."
command -v npm >/dev/null || fail "Node.js isn't installed (npm not found). Install Node.js 22 or newer."

cd "\$REPO"
# npm start installs dependencies, starts the server and opens the browser.
nohup npm start >"\$LOG" 2>&1 &

for _ in {1..120}; do
  curl -s -o /dev/null "\$URL" && exit 0
  sleep 0.5
done
fail "It didn't respond within a minute. Details are in ~/Library/Logs/RideReel.log."
EOF
chmod +x "$APP/Contents/MacOS/RideReel"

# --- Info.plist -------------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>RideReel</string>
  <key>CFBundleDisplayName</key><string>RideReel</string>
  <key>CFBundleIdentifier</key><string>local.ridereel.launcher</string>
  <key>CFBundleExecutable</key><string>RideReel</string>
  <key>CFBundleIconFile</key><string>RideReel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

# --- icon: orange rounded square with a play triangle, like the app's logo ---
cat > "$work/icon.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#ff6b1a"/>
  <path d="M420 330 L720 512 L420 694 Z" fill="#160800" stroke="#160800" stroke-width="40" stroke-linejoin="round"/>
</svg>
EOF
if qlmanage -t -s 1024 -o "$work" "$work/icon.svg" >/dev/null 2>&1 && [[ -f "$work/icon.svg.png" ]]; then
  mkdir "$work/RideReel.iconset"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$work/icon.svg.png" --out "$work/RideReel.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$work/icon.svg.png" --out "$work/RideReel.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$work/RideReel.iconset" -o "$APP/Contents/Resources/RideReel.icns"
else
  echo "Couldn't render the icon; the app will use the default one."
fi
touch "$APP"

# --- Dock -------------------------------------------------------------------
if (( ADD_TO_DOCK )); then
  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "RideReel.app"; then
    echo "Already in the Dock."
  else
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$APP</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
    killall Dock
    echo "Added to the Dock."
  fi
fi
echo "Done."
