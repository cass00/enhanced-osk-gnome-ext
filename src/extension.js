//import { Gio, GLib, St, Clutter, GObject } from 'gi://';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/keyboard.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const A11Y_APPLICATIONS_SCHEMA = "org.gnome.desktop.a11y.applications";
const KEY_RELEASE_TIMEOUT = 100;


//check how to get metadata

let settings;
let keyReleaseTimeoutId;

//Model class for _addrowKeys emulation
class KeyboardModel {
  constructor(groupName) {
    let names = [groupName];
    if (groupName.includes('+'))
      names.push(groupName.replace(/\+.*/, ''));
    names.push('us');

    for (let i = 0; i < names.length; i++) {
      try {
        this._model = this._loadModel(names[i]);
        break;
      } catch (e) {
      }
    }
  }

  _loadModel(groupName) {
    const file = Gio.File.new_for_uri(
      `resource:///org/gnome/shell/osk-layouts/${groupName}.json`);
    let [success_, contents] = file.load_contents(null);

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(contents));
  }

  getLevels() {
    return this._model.levels;
  }

  getKeysForLevel(levelName) {
    return this._model.levels.find(level => level === levelName);
  }
}

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
  //Main.keyboard._keyboard._keyboardController.destroy();
  //Main.keyboard._keyboard._setupKeyboard();
  if (Main.keyboard._keyboard !== null ){
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

function addition_createLayersforGroup(ref_this,groupName) {
  //console.log("osk: JS ERROR Running addition_create");
  //Idea: emulate _createLayersForGroup
  //copy over KeyboardModel class to here as extra class (not complex)
  //shiftKeys needs to be repopulated
  //loadRows directly in
  //check appendRow
  //then comes _addRowKeys
  //there instead of creating new button we load button from layout
  // then we disconnect button
  // then run all the rest of  wthe overwrite function
  // without appendKey function

  //Note: This is all necessary because Key class in keyboard.js is not exported
  //if exported then the original override_addRowKeys can be used

  //a is layers array that contains all layouts
  //let a =  ref_this._groups[ref_this._keyboardController.getCurrentGroup()];
  //a[n] is nth layout; then _rows[n] nth row;
  //keys[n] nth keyInfo (check appendKey function;
  //.key gives you then the key class
  //let b = a[0]._rows[0].keys[0].key
  //b.disconnect()
  //b.connect('released', () => {ref_this.close();});
  let keyboardModel = new KeyboardModel(groupName);
  let layers = ref_this._groups[ref_this._keyboardController.getCurrentGroup()];
  let levels = keyboardModel.getLevels();
  for (let i = 0; i < levels.length; i++) {
  //for (let i = 0; i < 0; i++) {
    let currentLevel = levels[i];
    let level = i >= 1 && levels.length === 3 ? i + 1 : i;
    let layout = layers[level]
    layout.shiftKeys = [];
    layout.mode = currentLevel.mode;
    //this._loadRows(currentLevel, level, levels.length, layout);
    //_loadRows(model, level, numLevels, layout) {
    let rows = currentLevel.rows;
    for (let j = 0; j < rows.length; ++j) {
      override_addRowKeys(ref_this,rows[j], layout,j);
    }
    layout.hide();
  }
}

function override_addRowKeys(ref_this, keys, layout,index_row) {
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    let button = layout._rows[index_row].keys[i].key

    if (key.iconName === 'keyboard-shift-symbolic'){
      layout.shiftKeys.push(button);
      button.connect('long-press', () => {
        ref_this._setActiveLayer(1);
        ref_this._setLatched(true);
        ref_this._iscapslock = true;
      });
    }
  }
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
    if (!this._modifiedLayouts) {
      const modifiedLayoutsPath = this.dir
            .get_child("data")
            .get_child("gnome-shell-osk-layouts.gresource")
            .get_path();
      this._modifiedLayouts = Gio.Resource.load(modifiedLayoutsPath);
    }
    return this._modifiedLayouts;
  }

  enable_overrides() {
    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_relayout',
      originalMethod => {
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
      originalMethod => {
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
        return function (...args) {
          originalMethod.call(this, ...args);
          this._keyboardController.getCurrentGroup = override_getCurrentGroup;
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_setupKeyboard',
      originalMethod => {
        return function (...args) {
          originalMethod.call(this, ...args);
          //track active level
          this._activelayer = 0;
          //track capslock
          this._iscapslock = false;
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_setActiveLayer',
      originalMethod => {
        return function (activeLevel) {
          let activeGroupName = this._keyboardController.getCurrentGroup();
          let layers = this._groups[activeGroupName];
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

          this._currentPage = currentPage;
          this._currentPage._destroyID = this._currentPage.connect('destroy', () => {
            this._currentPage = null;
          });
          this._updateCurrentPageVisible();
          this._aspectContainer.setRatio(...this._currentPage.getRatio());
          this._emojiSelection.setRatio(...this._currentPage.getRatio());
          //track the active level
          this._activelayer = activeLevel;
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_ensureKeysForGroup',
      originalMethod => {
        return function (group) {
          if (!this._groups[group]){
            this._groups[group] = this._createLayersForGroup(group);
            addition_createLayersforGroup(this,group);
          }
        }
      });

    //Allow level switching even though shift has
    //action: modifier
    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_toggleModifier',
      originalMethod => {
        return function (keyval) {
          const isActive = this._modifiers.has(keyval);
          const SHIFT_KEYVAL = '0xffe1';
          if (keyval === SHIFT_KEYVAL){
            //if capslock on just go back to layer 0
            //and do not activate modifier
            if (this._iscapslock){
              this._setLatched(false);
              this._setActiveLayer(0);
              this._iscapslock = false;
              this._disableAllModifiers();
            }
            //otherwise switch between layers
            else{
              if (this._activelayer == 1){
                this._setActiveLayer(0)}
              else{
                this._setActiveLayer(1);
              }
              this._setModifierEnabled(keyval, !isActive);
            }
          }
          else{
            this._setModifierEnabled(keyval, !isActive);
          };
        }
      });

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_commitAction',
      originalMethod => {
        return async function (keyval,str) {
          if (this._modifiers.size === 0 && str !== '' &&
              keyval && this._oskCompletionEnabled) {
            if (await Main.inputMethod.handleVirtualKey(keyval))
              return;
          }

          if (str === '' || !Main.inputMethod.currentFocus ||
              (keyval && this._oskCompletionEnabled) ||
              this._modifiers.size > 0 ||
              !this._keyboardController.commitString(str, true)) {
            if (keyval !== 0) {
              this._forwardModifiers(this._modifiers, Clutter.EventType.KEY_PRESS);
              this._keyboardController.keyvalPress(keyval);
              keyReleaseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_RELEASE_TIMEOUT, () => {
                this._keyboardController.keyvalRelease(keyval);
                this._forwardModifiers(this._modifiers, Clutter.EventType.KEY_RELEASE);
                //override start
                if (!this._iscapslock)
                  this._disableAllModifiers();
                //override end
                return GLib.SOURCE_REMOVE;
              });
            }
          }
        }
      })

    this._injectionManager.overrideMethod(
      Keyboard.Keyboard.prototype, '_toggleDelete',
      originalMethod => {
        return function (enabled) {
          if (this._deleteEnabled === enabled) return;

          this._deleteEnabled = enabled;

          if (enabled) {
            this._keyboardController.keyvalPress(Clutter.KEY_BackSpace);
          } else {
            this._keyboardController.keyvalRelease(Clutter.KEY_BackSpace);
          }
        }
      });

    // Register modified osk layouts resource file
    this.getModifiedLayouts()._register();
  }

  disable_overrides() {
    this._injectionManager.clear();
    this._injectionManager = null;

    // Unregister modified osk layouts resource file
    this.getModifiedLayouts()._unregister();
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
