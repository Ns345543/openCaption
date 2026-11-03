openCaption - install on Windows
===============================

openCaption is a free panel for Adobe Premiere Pro that turns your timeline
audio into a real caption track. It uses your own Google Gemini API key and
never renders or exports audio.

You need:
  - Windows 10 or 11
  - Premiere Pro 2022 (22.0) or newer
  - A Google Gemini API key: https://aistudio.google.com/apikey  (free tier works)
  - Optional, for AI Chat: a Groq API key: https://console.groq.com/keys

The panel and ffmpeg are included in this package. Nothing else to download.


INSTALL (easiest)
-----------------
1. Extract this whole zip somewhere, e.g. your Downloads folder.
   Do not run anything from inside the zip viewer.
2. Close Premiere Pro completely.
3. Double-click  install.bat
   - If Windows shows "Windows protected your PC", click "More info" then
     "Run anyway". The script only copies files into your user profile.
4. Start Premiere Pro.
5. Window > Extensions > openCaption.
6. Paste your API key and press Save.

That is it. The installer copies the panel to:

  %APPDATA%\Adobe\CEP\extensions\com.captionai.panel

and enables the settings Premiere needs to load a free (self-signed) panel.
No administrator rights are used and nothing system-wide is changed.

To remove it later, run  uninstall.bat  in this folder.


INSTALL FROM A .ZXP
-------------------
If you already use a CEP extension manager (Anastasiy's Extension Manager,
ZXP/UXP installer, or Adobe ExManCmd), install openCaption.zxp with it
instead of running install.bat.

openCaption is a CEP panel, not a UXP plugin. If an installer says
"manifest.json not found", it is a UXP-only tool: use install.bat, or a CEP
installer such as the free ZXPInstaller, instead.

A .zxp from this project is signed with a self-signed certificate, which CEP
only loads when PlayerDebugMode is on. If the panel does not appear in
Window > Extensions after a ZXP install, run install.bat once (it enables that
setting), then restart Premiere. install.bat does not remove the ZXP copy; it
installs the same panel into your user profile, which is the copy Premiere
will use.


FIRST RUN
---------
1. Window > Extensions > openCaption.
2. Paste your Gemini API key, press "Save", then "test" to check it.
3. Open a sequence in Premiere.
4. Press "Generate captions".

By default the panel uses whatever is selected on the timeline, else the work
area, else the whole sequence. Captions land on a caption track, and the
imported .srt is filed under a "99 openCaption" bin at the top of your project.
The files also stay on disk in %APPDATA%\CaptionAI\captions.

AI CHAT (optional)
------------------
Click the chat bubble icon in the panel header (next to the openCaption name)
to open OpenCaption AI. It uses a separate Groq API key: open "AI Chat
settings" in the overlay, paste a key from https://console.groq.com/keys, and
press Connect. Chat history and the chat key live in
%APPDATA%\CaptionAI\chat.json; caption settings and the Gemini key stay in
config.json. The chat key is sent only to api.groq.com.


UPDATES
-------
openCaption 1.5.0 and newer checks GitHub when the panel opens. When a newer
release exists, a banner appears inside the panel with an "Update now" button.
The footer also has a "check for updates" link.

"Update now" downloads the release from the openCaption GitHub page, verifies
its SHA-256 checksum, and then waits for you to close Premiere Pro. It replaces
the panel and reopens Premiere. Your API key and settings in
%APPDATA%\CaptionAI are kept.

If you are on 1.4.x or older, install 1.5.0 once by hand: older versions do not
check for updates. If the panel cannot install automatically (for example, a
copy under Program Files), the button opens the release page instead.


TROUBLESHOOTING
---------------
Panel missing from Window > Extensions
  Close Premiere, run install.bat again, then reopen Premiere. The panel only
  appears after a full restart.

"manifest.json not found" during install
  You used a UXP-only installer. openCaption is a CEP panel: use install.bat,
  or the free ZXPInstaller / Anastasiy's Extension Manager.

"Node.js is not available in this panel"
  The panel did not load its Node runtime. Reinstall with install.bat and
  restart Premiere.

"ffmpeg.exe not found"
  The bundled helper was blocked or deleted. Re-extract the zip and reinstall;
  if the package came without it, install.bat downloads it automatically, or
  point the panel at any ffmpeg.exe under Advanced.

"produced no output" / request times out
  The API key is fine but that model is slow on the free tier. Press "test"
  next to Model and choose a flash-lite model.

Every request retries 429
  Free-tier rate limit. Set Advanced > Parallel to 1 and Chunk length to 60.

Your API keys are stored only on this computer, obfuscated, in
%APPDATA%\CaptionAI\config.json (Gemini) and chat.json (Groq). Each key is sent
only to its own service: Gemini to Google, Groq to api.groq.com. This is local
obfuscation, not encryption.
