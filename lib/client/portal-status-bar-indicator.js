const {CompositeDisposable} = require('atom');
const PopoverComponent = require('./../components/popover-component.js');
const log = require('loglevel').getLogger('portal-status-bar-indicator');
const config = require('./../config.js');
log.setLevel(config.logLevels.views);

/**
 * Class that defines the logic necessary to render the portal's status bar
 * indicator. Note that the only model this "view" class subscribes to is the
 */
class PortalStatusBarIndicator {
  /**
   * Expected parameters
   * @param {Object} statusBar
   * @param {Object} portalStore
   * @param {Object} commandRegistry
   * @param {Object} clipboard
   * @param {Object} workspace
   * @param {Object} notificationManager
   * @param {Object} tooltipManager
   */
  constructor(props) {
    // Defensive copying in order to avoid downstream changes to `props`
    // propagating upstream.
    this.props = Object.assign({}, props);

    this.subscriptions = new CompositeDisposable();
    this.element = buildElement(props);
    this.popoverComponent = new PopoverComponent(props);
    this.props.portalStore.onPortalsStatusChange(() => {
      this.updatePortalStatus()
    });
  }

  /**
   * Attach a tooltip to this class's DOM element so that the pop-up shows up
   * when the DOM element of the portal status bar indicator is clicked.
   */
  attach() {
    const _PRIORITY = -100;
    // Add a tile to the right side of the status bar. The priority controls
    // where exactly in the status bar the tile is placed.
    this.tile = this.props.statusBar.addRightTile({
      item: this,
      priority: _PRIORITY
    });
    // Add an event listener so that the `PopoverComponent` pops up when the
    // DOM element for this class (see the `buildElement` function) is clicked.
    const tooltip = this.props.tooltipManager.add(
      this.element,
      {
        item: this.popoverComponent,
        class: 'PapyrusPopoverTooltip',
        trigger: 'click',
        placement: 'top'
      }
    );
    this.subscriptions.add(tooltip);
  }

  /**
   * Destroy the portal status bar indicator and all its subscriptions.
   */
  destroy() {
    if (this.tile) this.tile.destroy();
    this.subscriptions.dispose();
  }

  /**
   * Show the popover component
   */
  showPopover() {
    // If necessary, simulate a click on the DOM element of "this" class so that
    // the PopoverComponent component will show up (see `attach` function).
    if (!this.isPopoverVisible()) this.element.click();
  }

  /**
   * Hide the popover component
   */
  hidePopover() {
    if (this.isPopoverVisible()) this.element.click();
  }

  /**
   * Returns `true` iff the popover component is currently visible (we check
   * this by checking whether there is a DOM node that refers to the popover
   * component).
   */
  isPopoverVisible() {
    return document.contains(this.popoverComponent.element);
  }

  /**
   * Visually update "this" class' DOM element.
   */
  updatePortalStatus() {
    const transmitting = this.props.portalStore.hasActivePortals();
    // Simply change CSS styling of DOM element by updating its CSS classes.
    if (transmitting) {
      this.element.classList.add('transmitting');
    } else {
      this.element.classList.remove('transmitting');
    }
  }
}

/**
 * Build DOM element for the portal's status bar indicator while taking into
 * account the given properties.
 */
function buildElement(props) {
  const anchor = document.createElement('a');
  anchor.classList.add('PortalStatusBarIndicator', 'inline-block');
  const icon = document.createElement('span');
  icon.classList.add('icon', 'icon-radio-tower');
  anchor.appendChild(icon);
  return anchor;
}

module.exports = PortalStatusBarIndicator;
