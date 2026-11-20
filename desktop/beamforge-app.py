#!/usr/bin/env python3
"""BeamForge desktop app: a native window (GTK + WebKit) around the BeamForge UI.

Starts the local BeamForge server if it isn't already running, then shows the UI in its own
window — no browser tabs or address bar. Saving files (projects, G-code, SVG...) opens a normal
"Save as" dialog. Closing the window never stops a running job: the server only shuts itself
down once no window is open and no job is running.
"""
import os
import subprocess
import sys
import time
import urllib.request

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gio, GLib, Gtk, WebKit2  # noqa: E402

APP_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PORT = os.environ.get('BEAMFORGE_PORT', '8787')
URL = f'http://localhost:{PORT}/'
DATA = os.path.join(os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share')), 'beamforge', 'webview')
CACHE = os.path.join(os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache')), 'beamforge', 'webview')
LOG = os.path.join(os.environ.get('XDG_STATE_HOME', os.path.expanduser('~/.local/state')), 'beamforge.log')


def server_up():
    try:
        urllib.request.urlopen(URL, timeout=1).close()
        return True
    except Exception:
        return False


def start_server():
    if server_up():
        return True
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    env = dict(os.environ, BEAMFORGE_AUTO_EXIT='1', BEAMFORGE_PORT=PORT)
    with open(LOG, 'ab') as log:
        subprocess.Popen(['node', os.path.join(APP_DIR, 'server.js')], cwd=APP_DIR, env=env,
                         stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(80):
        if server_up():
            return True
        time.sleep(0.1)
    return False


class BeamForgeApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='com.beamforge.BeamForge', flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.win = None

    def do_activate(self):
        if self.win:  # second launch: just bring the existing window forward
            self.win.present()
            return
        GLib.set_prgname('beamforge')
        GLib.set_application_name('BeamForge')
        Gtk.Window.set_default_icon_name('beamforge')

        if not start_server():
            d = Gtk.MessageDialog(message_type=Gtk.MessageType.ERROR, buttons=Gtk.ButtonsType.CLOSE,
                                  text='BeamForge could not start')
            d.format_secondary_text(f'The BeamForge engine did not start. Details are in:\n{LOG}')
            d.run()
            d.destroy()
            return

        os.makedirs(DATA, exist_ok=True)
        os.makedirs(CACHE, exist_ok=True)
        manager = WebKit2.WebsiteDataManager(base_data_directory=DATA, base_cache_directory=CACHE)
        ctx = WebKit2.WebContext.new_with_website_data_manager(manager)
        ctx.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)
        ctx.connect('download-started', self.on_download)

        view = WebKit2.WebView.new_with_context(ctx)
        s = view.get_settings()
        s.set_enable_developer_extras(bool(os.environ.get('BEAMFORGE_DEVTOOLS')))
        s.set_enable_write_console_messages_to_stdout(bool(os.environ.get('BEAMFORGE_DEVTOOLS')))
        s.set_javascript_can_access_clipboard(True)
        s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
        view.connect('decide-policy', self.on_policy)
        view.connect('context-menu', lambda *a: not os.environ.get('BEAMFORGE_DEVTOOLS'))  # no "Reload/Back" menu
        view.connect('web-process-terminated', lambda v, r: v.reload())
        if os.environ.get('BEAMFORGE_SELFTEST'):
            view.connect('load-changed', self.selftest)
        view.load_uri(URL)

        win = Gtk.ApplicationWindow(application=self, title='BeamForge')
        win.set_default_size(1500, 950)
        win.set_icon_name('beamforge')
        win.add(view)
        win.maximize()
        win.show_all()
        self.win, self.view = win, view

    # Keep the window on BeamForge; open any outside links in the normal web browser.
    def on_policy(self, view, decision, kind):
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION or kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if not uri.startswith(URL) and not uri.startswith(('blob:', 'data:', 'about:')):
                Gtk.show_uri_on_window(self.win, uri, Gtk.get_current_event_time())
                decision.ignore()
                return True
        return False

    # File saving: show a "Save as" dialog instead of dropping files into Downloads.
    def on_download(self, ctx, download):
        download.connect('decide-destination', self.on_destination)
        download.connect('failed', lambda d, e: self.toast(f'Saving failed: {e.message}'))

    def on_destination(self, download, suggested):
        if os.environ.get('BEAMFORGE_SAVE_TO'):  # self-test: no dialog
            download.set_allow_overwrite(True)
            download.set_destination(GLib.filename_to_uri(os.path.join(os.environ['BEAMFORGE_SAVE_TO'], suggested)))
            return True
        dlg = Gtk.FileChooserNative.new('Save', self.win, Gtk.FileChooserAction.SAVE, '_Save', '_Cancel')
        dlg.set_do_overwrite_confirmation(True)
        dlg.set_current_name(suggested or 'design')
        last = getattr(self, 'last_dir', None) or GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) or os.path.expanduser('~')
        dlg.set_current_folder(last)
        if dlg.run() == Gtk.ResponseType.ACCEPT:
            path = dlg.get_filename()
            self.last_dir = os.path.dirname(path)
            download.set_allow_overwrite(True)
            download.set_destination(GLib.filename_to_uri(path))
        else:
            download.cancel()
        dlg.destroy()
        return True

    # BEAMFORGE_SELFTEST=1: check the UI booted in the app window, print the result and quit.
    def selftest(self, view, event):
        if event != WebKit2.LoadEvent.FINISHED:
            return
        js = """
          for (let i = 0; i < 50 && !window.beamforge; i++) await new Promise(r => setTimeout(r, 100));
          const b = window.beamforge; if (!b) return 'FAIL: UI did not start';
          b.ACTIONS.save();
          const c = document.querySelector('canvas');
          return 'OK ' + JSON.stringify({ layers: b.S.layers.length, device: b.dev().type, canvas: c && [c.width, c.height],
            storage: (localStorage.setItem('bf.selftest', '1'), localStorage.getItem('bf.selftest')) });
        """
        def done(v, res):
            try:
                print(v.call_async_javascript_function_finish(res).to_string(), flush=True)
            except Exception as e:
                print('FAIL', e, flush=True)
            GLib.timeout_add(1500, self.quit)
        view.call_async_javascript_function(js, -1, None, None, None, None, done)

    def toast(self, text):
        d = Gtk.MessageDialog(transient_for=self.win, message_type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.OK, text=text)
        d.run()
        d.destroy()


if __name__ == '__main__':
    sys.exit(BeamForgeApp().run(sys.argv[:1]))
