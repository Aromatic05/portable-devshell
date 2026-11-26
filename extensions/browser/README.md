# DevShell Browser

A command extension for Headless Chromium. Models use the Playwright CLI through
devshell browser; users can operate the same browser in the DevShell WebUI.
No additional MCP tools, standalone web server, or system service is required.

## Install a distributed product directory

The release directory contains extension/ and runtime/. Transfer it as a unit to
the Control host. The runtime must match the target Worker OS and architecture.

    devshell extension install ./extension
    devshell browser runtime install <instance> ./runtime

Runtime installation imports the immutable bundle into Extension Assets, projects
it to the selected Worker and checks that the bundled Chromium actually launches.
No npm or installed browser is needed on the target Worker. Chromium's normal
system libraries and fonts must be available.

Enable browser in the target Instance's model extension list using DevShell's
existing Instance configuration UI. The native CLI and WebUI remain user-facing.
For additional Workers, use Manage in the Browser WebUI to project the imported
bundle to the selected Instance, or run runtime use with the bundle generation.

## Use

    devshell browser --instance <instance> --profile work open https://example.com
    devshell browser --profile work snapshot
    devshell browser --profile work click <ref>
    devshell browser --profile work fill <ref> <text>
    devshell browser --profile work screenshot
    devshell browser --profile work files list
    devshell browser --profile work files export <file> ./output.png
    devshell browser --profile work close

The native CLI selects an Instance explicitly; the model uses its originating
Instance. File export uses the existing Artifact transfer service and the model's
authoritative workspace. It does not overwrite existing destination files.
The underlying Playwright CLI supplies the browser automation command vocabulary.

Open Browser from the DevShell WebUI, select Instance/Profile, then Open / attach.
The viewer supports navigation, tabs, keyboard, mouse, scrolling, text composition
and paste. Detach viewer stops its capture subscription without closing Chromium.
Close browser closes that session. Manage provides runtime selection, profile
creation/deletion, credential import/clear, output downloads and activity logs.
Model command waits do not serialize human pointer/keyboard input.

## Profiles and credentials

Profile storage is persistent on its Worker. Cookies and LocalStorage are managed
by Chromium. Delete is an explicit user operation that removes the selected
profile's data and its stored credentials. The default profile is named default.

Credential import accepts a Playwright dotenv file and replaces that profile's
stored credentials. It is available in Manage or from the local Control owner CLI:

    devshell browser --instance <instance> --profile work credential import ./credentials.env
    devshell browser --instance <instance> --profile work credential list
    devshell browser --instance <instance> --profile work credential clear

The model can list credential names and pass a name to Playwright fill.
The upstream CLI supplies substitution and ordinary output redaction. Changes
apply on the next browser session. The credential store is a private file,
not an encrypted vault; arbitrary automation and Worker filesystem access are
not a security boundary. Only use profiles and credentials with trusted agents.
Browser action and request metadata are stored in the Extension's SQLite database,
not the DevShell core audit database.

## Build the distributable product

On the target OS/architecture with Node.js 24 and npm installed:

    pnpm --filter @portable-devshell/browser-extension package-product /absolute/path/to/new-product-directory

The build stages extension/, pinned Playwright CLI, Node, Chromium Headless Shell,
and the helper in runtime/. The runtime directory is independently transferable.
Alternatively prepare-runtime builds the runtime alone after the extension build.
For an offline rebuild, pass an existing prepared runtime directory as a second
argument to package-product; the current Helper and Wire files are regenerated.

## Architecture

Control: Browser owns instance/profile sessions and Runtime assets; Session
implements request/reply and latest-frame fan-out; Store owns the SQLite schema;
Credentials manages profile-specific user input; Wire defines frame records.

Worker: the Helper owns Chromium through public Playwright APIs. The upstream
CLI attaches to the named pipe returned by browser.bind(). Browser files stay
inside the profile's separate CLI output directory. The DevShell Worker process
byte stream carries control messages and JPEG frames.

WebUI: RemoteBrowser uses the existing Control RPC/Stream protocol; Input maps
DOM events and composition; FrameView decodes the latest JPEG into Canvas;
Management implements the user-facing settings and
output workflows. The sandbox bridge retains its JSON ABI; network frame streams
carry bytes. The extension has no browser-specific Core API or HTTP server.

## Acceptance

The Runtime test exercises the real Worker helper, shared browser input,
credentials, profile storage and frame capture. Product.mjs is an end-to-end
acceptance for an explicitly isolated DevShell testspace with the extension and
runtime installed, including model commands and the actual rendered WebUI.

    node extensions/browser/test/Runtime.test.mjs /path/to/runtime
    pnpm testspace exec node /absolute/path/to/extensions/browser/test/Product.mjs /absolute/path/to/runtime

Linux x86_64 is the initial target; other runtime platform builds and abnormal
descendant-process cleanup must be validated on their respective platforms.
