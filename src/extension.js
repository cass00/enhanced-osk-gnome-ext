//import { Gio, GLib, St, Clutter, GObject } from 'gi://';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/keyboard.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const A11Y_APPLICATIONS_SCHEMA = "org.gnome.desktop.a11y.applications";


//check how to get metadata

let settings;
let keyReleaseTimeoutId;

// Indicator
let OSKIndicator = GObject.registerClass(
  { GTypeName: "OSKIndicator" },
  class OSKIndicator extends PanelMenu.Button {
    _init(ref_this) {
      super._init(0.0, `${ref_this.metadata.name} Indicator`, false);

      let icon = new St.Icon({
        icon_name: "input-keyboard-symbolic",
        style_class: "system-status-icon",
      });

      this.add_child(icon);

      this.connect("button-press-event", function (_actor, event) {
        let button = event.get_button();

        if (button == 1) {
          toggleOSK();
        }

        if (button == 3) {
          ref_this.openPreferences();
        }
      });

      this.connect("touch-event", function () {
        toggleOSK();
      });
    }
  }
);

function toggleOSK() {
  if (Main.keyboard._keyboard !== null) {
    if (Main.keyboard._keyboard._keyboardVisible) return Main.keyboard.close();
    Main.keyboard.open(Main.layoutManager.bottomIndex);
  }
}

function override_getCurrentGroup() {
  // Special case for Korean, if Hangul mode is disabled, use the 'us' keymap
  if (this._currentSource.id === 'hangul') {
    const inputSourceManager = InputSourceManager.getInputSourceManager();
    const currentSource = inputSourceManager.currentSource;
    let prop;
    for (let i = 0; (prop = currentSource.properties.get(i)) !== null; ++i) {
      if (prop.get_key() === 'InputMode' &&
        prop.get_prop_type() === IBus.PropType.TOGGLE &&
        prop.get_state() !== IBus.PropState.CHECKED)
        return 'us';
    }
  }
  return this._currentSource.xkbId;
}

// Extension
export default class enhancedosk extends Extension {
  constructor(metadata) {
    super(metadata);
  }

  enable() {
    this._injectionManager = new InjectionManager();

    settings = this.getSettings(
      "org.gnome.shell.extensions.enhancedosk"
    );
    this.currentSeat = Clutter.get_default_backend().get_default_seat();
    this.backup_touchMode = this.currentSeat.get_touch_mode;

    this._oskA11yApplicationsSettings = new Gio.Settings({
      schema_id: A11Y_APPLICATIONS_SCHEMA,
    });

    Main.layoutManager.removeChrome(Main.layoutManager.keyboardBox);

    // Set up the indicator in the status area
    if (settings.get_boolean("show-statusbar-icon")) {
      this._indicator = new OSKIndicator(this);
      Main.panel.addToStatusArea("OSKIndicator", this._indicator);
    }

    if (settings.get_boolean("force-touch-input")) {
      this.currentSeat.get_touch_mode = () => true;
    }

    this.tryDestroyKeyboard();

    this.enable_overrides();

    settings.connect("changed::show-statusbar-icon", () => {
      if (settings.get_boolean("show-statusbar-icon")) {
        this._indicator = new OSKIndicator(this);
        Main.panel.addToStatusArea("OSKIndicator", this._indicator);
      } else if (this._indicator !== null) {
        this._indicator.destroy();
        this._indicator = null;
      }
    });

    settings.connect("changed::force-touch-input", () => {
      if (settings.get_boolean("force-touch-input")) {
        this.currentSeat.get_touch_mode = () => true;
      } else {
        this.currentSeat.get_touch_mode = this.backup_touchMode;
      }
    });

    Main.keyboard._syncEnabled();
    Main.keyboard._bottomDragAction.enabled = true;

    Main.layoutManager.addTopChrome(Main.layoutManager.keyboardBox, {
      affectsStruts: settings.get_boolean("resize-desktop"),
      trackFullscreen: false,
    });
  }

  disable() {
    Main.layoutManager.removeChrome(Main.layoutManager.keyboardBox);

    this.currentSeat.get_touch_mode = this.backup_touchMode;

    this.tryDestroyKeyboard();

    // Remove indicator if it exists
    if (this._indicator instanceof OSKIndicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    settings = null;
    this._oskA11yApplicationsSettings = null;
    this.currentSeat = null;

    if (keyReleaseTimeoutId) {
      GLib.Source.remove(keyReleaseTimeoutId);
      keyReleaseTimeoutId = null;
    }

    this.disable_overrides();

    Main.keyboard._syncEnabled();
    Main.keyboard._bottomDragAction.enabled = true;

    Main.layoutManager.addTopChrome(Main.layoutManager.keyboardBox);
  }

  getModifiedLayouts() {
    const modifiedLayoutsPath = this.dir
      .get_child("data")
      .get_child("gnome-shell-osk-layouts.gresource")
      .get_path();
    return Gio.Resource.load(modifiedLayoutsPath);
  }

  enable_overrides() {
    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_relayout',
      _ => {
        return function (...args) {
          let monitor = Main.layoutManager.keyboardMonitor;
          if (!monitor) return;
          this.width = monitor.width;
          if (monitor.width > monitor.height) {
            this.height = (monitor.height *
              settings.get_int("landscape-height")) / 100;
          } else {
            this.height = (monitor.height *
              settings.get_int("portrait-height")) / 100;
          }

          if (settings.get_boolean("show-suggestions")) {
            this._suggestions?.show();
          } else {
            this._suggestions?.hide();
          }
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.KeyboardManager.prototype, '_lastDeviceIsTouchscreen',
      _ => {
        return function (...args) {
          if (!this._lastDevice)
            return false;

          let deviceType = this._lastDevice.get_device_type();
          return settings.get_boolean("ignore-touch-input")
            ? false
            : deviceType === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE;
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_init',
      originalMethod => {
        return function () {
          originalMethod.call(this);
          this._keyboardController.getCurrentGroup = override_getCurrentGroup;
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_setupKeyboard',
      originalMethod => {
        return function () {
          originalMethod.call(this);
          //track active level
          this._activeLevel = 'default';
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_setActiveLevel',
      _ => {
        return function (activeLevel) {
          const layers = this._layers;
          let currentPage = layers[activeLevel];

          if (this._currentPage === currentPage) {
            this._updateCurrentPageVisible();
            return;
          }

          if (this._currentPage != null) {
            this._setCurrentLevelLatched(this._currentPage, false);
            this._currentPage.disconnect(this._currentPage._destroyID);
            this._currentPage.hide();
            delete this._currentPage._destroyID;
          }

          this._disableAllModifiers();
          this._currentPage = currentPage;
          this._currentPage._destroyID = this._currentPage.connect('destroy', () => {
            this._currentPage = null;
          });
          this._updateCurrentPageVisible();
          this._aspectContainer.setRatio(...this._currentPage.getRatio());
          this._emojiSelection.setRatio(...this._currentPage.getRatio());
          //track the active level
          this._activeLevel = activeLevel;
        }
      });

    //Allow level switching even though shift has
    //action: modifier
    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_toggleModifier',
      _ => {
        return function (keyval) {
          const isActive = this._modifiers.has(keyval);
          const SHIFT_KEYVAL = '0xffe1';
          if (keyval === SHIFT_KEYVAL) {
            //if capslock on just go back to layer 0
            //and do not activate modifier
            if (this._longPressed) {
              this._setLatched(false);
              this._setActiveLevel('default');
              this._longPressed = false;
              this._disableAllModifiers();
            }
            //otherwise switch between layers
            else {
              if (this._activeLevel == 'shift') {
                this._setActiveLevel('default')
              }
              else {
                this._setActiveLevel('shift');
              }
              this._setModifierEnabled(keyval, !isActive);
            }
          }
          else {
            this._setModifierEnabled(keyval, !isActive);
          };
        }
      });

    // Unregister original osk layouts resource file
    this.getDefaultLayouts()._unregister();

    // Register modified osk layouts resource file
    this.getModifiedLayouts()._register();
  }

  disable_overrides() {
    this._injectionManager.clear();
    this._injectionManager = null;

    // Unregister modified osk layouts resource file
    this.getModifiedLayouts()._unregister();

    // Register original osk layouts resource file
    this.getDefaultLayouts()._register();
  }

  getDefaultLayouts() {
    return Gio.Resource.load(
      (GLib.getenv("JHBUILD_PREFIX") || "/usr") +
      "/share/gnome-shell/gnome-shell-osk-layouts.gresource"
    );
  }

  // In case the keyboard is currently disabled in accessibility settings, attempting to _destroyKeyboard() yields a TypeError ("TypeError: this.actor is null")
  // This function proofs this condition, which would be used in the parent function to determine whether to run _setupKeyboard
  tryDestroyKeyboard() {
    try {
      Main.keyboard._keyboard.destroy();
      Main.keyboard._keyboard = null;
    } catch (e) {
      if (e instanceof TypeError) {
        return false;
        //throw e;
      } else {
        // Something different happened
        throw e;
      }
    }
    return true;
  }
}
