import React, { Component } from 'react';
import PropTypes from 'prop-types';
import shallowCompare from 'react-addons-shallow-compare';
import update from 'react-addons-update';
import cn from 'classnames';

import {
  isArray,
  closest,
  getOffsetRect,
  getTotalScroll,
  getTransformProps,
  listWithChildren,
  getAllNonEmptyNodesIds
} from '../utils';

import './Nestable.css';
import NestableItem from './NestableItem';

class Nestable extends Component {
  constructor(props) {
    super(props);
    this.state = {
      items: [],
      itemsOld: null, // snap copy in case of canceling drag
      dragItem: null,
      isDirty: false,
      collapsedGroups: props.collapsedGroups || [],
      realPathTo: [],
    };

    this.el = null;
    this.elCopyStyles = null;
    this.mouse = {
      last: { x: 0 },
      shift: { x: 0 }
    };
  }

  static propTypes = {
    isDisabled: PropTypes.bool,
    items: PropTypes.arrayOf(
      PropTypes.shape({
        number: PropTypes.any.isRequired
      })
    ),
    threshold: PropTypes.number,
    maxDepth: PropTypes.number,
    collapsed: PropTypes.bool,
    collapsedGroups: PropTypes.arrayOf(PropTypes.number),
    group: PropTypes.oneOfType([
      PropTypes.number,
      PropTypes.string
    ]),
    childrenProp: PropTypes.string,
    className: PropTypes.string,
    renderItem: PropTypes.func,
    renderCollapseIcon: PropTypes.func,
    handler: PropTypes.node,
    onMove: PropTypes.func,
    onChange: PropTypes.func,
    onToggleCollapse: PropTypes.func,
  };
  static defaultProps = {
    items: [],
    threshold: 30,
    maxDepth: 10,
    collapsed: false,
    collapsedGroups: [],
    group: Math.random().toString(36).slice(2),
    childrenProp: 'children',
    renderItem: ({ item }) => item.toString(),
    onMove: () => {
      return true;
    },
    onChange: () => {
    },
    onToggleCollapse: () => {

    }
  };

  componentDidMount() {
    let { items, childrenProp } = this.props;

    // make sure every item has property 'children'
    items = listWithChildren(items, childrenProp);

    this.setState({ items });
  }

  componentWillReceiveProps(nextProps) {
    const { items: itemsNew, childrenProp } = nextProps;
    const isPropsUpdated = shallowCompare({ props: this.props, state: {} }, nextProps, {});

    if (isPropsUpdated) {
      this.stopTrackMouse();

      let extra = {};

      if (this.props.collapsed !== nextProps.collapsed) {
        extra.collapsedGroups = [];
      }

      if (nextProps.collapsed) {
        extra.collapsedGroups = nextProps.collapsedGroups;
      }

      this.setState({
        items: listWithChildren(itemsNew, childrenProp),
        dragItem: null,
        isDirty: false,
        ...extra
      });
    }
  }

  componentWillUnmount() {
    this.stopTrackMouse();
  }

  // ––––––––––––––––––––––––––––––––––––
  // Public Methods
  // ––––––––––––––––––––––––––––––––––––
  collapse = (itemIds) => {
    const { childrenProp, collapsed } = this.props;
    const { items } = this.state;

    if (itemIds == 'NONE') {
      this.setState({
        collapsedGroups: collapsed
          ? getAllNonEmptyNodesIds(items, childrenProp)
          : []
      });

    } else if (itemIds == 'ALL') {
      this.setState({
        collapsedGroups: collapsed
          ? []
          : getAllNonEmptyNodesIds(items, childrenProp)
      });

    } else if (isArray(itemIds)) {
      this.setState({
        collapsedGroups: getAllNonEmptyNodesIds(items, childrenProp)
          .filter(number => (itemIds.indexOf(number) > -1) ^ collapsed)
      });
    }
  };

  toggleCollapseGroup = (num) => {
    let collapsedGroups = this.state.collapsedGroups
    const foundNum = collapsedGroups.findIndex(n => n === num)
    if (foundNum >= 0) {
      collapsedGroups.splice(foundNum, 1)
      this.props.onToggleCollapse(num, false)
    } else {
      collapsedGroups.push(num)
      this.props.onToggleCollapse(num, true)
    }
    this.setState({ collapsedGroups })
  }

  // ––––––––––––––––––––––––––––––––––––
  // Methods
  // ––––––––––––––––––––––––––––––––––––
  startTrackMouse = () => {
    if (this.props.isDisabled) return
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onDragEnd);
    document.addEventListener('keydown', this.onKeyDown);
  };

  stopTrackMouse = () => {
    if (this.props.isDisabled) return
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onDragEnd);
    document.removeEventListener('keydown', this.onKeyDown);
    this.elCopyStyles = null;
  };

  moveItem({ dragItem, pathFrom, pathTo }, extraProps = {}) {
    if (this.props.isDisabled) return
    const { childrenProp } = this.props;
    let { items } = this.state;

    // the remove action might affect the next position,
    // so update next coordinates accordingly
    const realPathTo = this.getRealNextPath(pathFrom, pathTo);
    this.setState({realPathTo})


    const removePath = this.getSplicePath(pathFrom, {
      numToRemove: 1,
      childrenProp: childrenProp
    });

    const insertPath = this.getSplicePath(realPathTo, {
      numToRemove: 0,
      itemsToInsert: [dragItem],
      childrenProp: childrenProp
    });

    items = update(items, removePath);
    items = update(items, insertPath);

    this.setState({
      items,
      isDirty: true,
      ...extraProps
    });
  }

  tryIncreaseDepth(dragItem) {
    const { maxDepth, childrenProp, collapsed } = this.props;
    const pathFrom = this.getPathById(dragItem.number);
    const itemIndex = pathFrom[pathFrom.length - 1];
    const newDepth = pathFrom.length + this.getItemDepth(dragItem);

    // has previous sibling and isn't at max depth
    if (itemIndex > 0 && newDepth <= maxDepth) {
      const prevSibling = this.getItemByPath(pathFrom.slice(0, -1).concat(itemIndex - 1));

      // previous sibling is not collapsed
      if (!prevSibling[childrenProp].length || !this.isCollapsed(prevSibling)) {
        const pathTo = pathFrom
          .slice(0, -1)
          .concat(itemIndex - 1)
          .concat(prevSibling[childrenProp].length);

        // if collapsed by default
        // and was no children here
        // open this node
        let collapseProps = {};
        if (collapsed && !prevSibling[childrenProp].length) {
          collapseProps = this.onToggleCollapse(prevSibling, true);
        }

        this.moveItem({ dragItem, pathFrom, pathTo }, collapseProps);
      }
    }
  }

  tryDecreaseDepth(dragItem) {
    const { childrenProp, collapsed } = this.props;
    const pathFrom = this.getPathById(dragItem.number);
    const itemIndex = pathFrom[pathFrom.length - 1];

    // has parent
    if (pathFrom.length > 1) {
      const parent = this.getItemByPath(pathFrom.slice(0, -1));

      // is last (by order) item in array
      if (itemIndex + 1 == parent[childrenProp].length) {
        let pathTo = pathFrom.slice(0, -1);
        pathTo[pathTo.length - 1] += 1;

        // if collapsed by default
        // and is last (by count) item in array
        // remove this node from list of open nodes
        let collapseProps = {};
        if (collapsed && parent[childrenProp].length == 1) {
          collapseProps = this.onToggleCollapse(parent, true);
        }

        this.moveItem({ dragItem, pathFrom, pathTo }, collapseProps);
      }
    }
  }

  dragApply() {
    const { onMove, onChange } = this.props;
    const { items, isDirty, dragItem, realPathTo } = this.state;


    if (onMove && isDirty && !onMove(items, dragItem, realPathTo)) {
      this.dragRevert();
      return;
    }


    this.setState({
      itemsOld: null,
      dragItem: null,
      isDirty: false
    });

    onChange && isDirty && onChange(items, dragItem, realPathTo);
  }

  dragRevert() {
    const { itemsOld } = this.state;

    this.setState({
      items: itemsOld,
      itemsOld: null,
      dragItem: null,
      isDirty: false
    });
  }

  // ––––––––––––––––––––––––––––––––––––
  // Getter methods
  // ––––––––––––––––––––––––––––––––––––
  getPathById(number, items = this.state.items) {
    const { childrenProp } = this.props;
    let path = [];

    items.every((item, i) => {
      if (item.number === number) {
        path.push(i);
      } else if (item[childrenProp]) {
        const childrenPath = this.getPathById(number, item[childrenProp]);

        if (childrenPath.length) {
          path = path.concat(i).concat(childrenPath);
        }
      }

      return path.length == 0;
    });

    return path;
  }

  getItemByPath(path, items = this.state.items) {
    const { childrenProp } = this.props;
    let item = null;

    path.forEach(index => {
      const list = item ? item[childrenProp] : items;
      item = list[index];
    });

    return item;
  }

  getItemDepth = (item) => {
    const { childrenProp } = this.props;
    let level = 1;

    if (item[childrenProp].length > 0) {
      const childrenDepths = item[childrenProp].map(this.getItemDepth);
      level += Math.max(...childrenDepths);
    }

    return level;
  };

  getSplicePath(path, options = {}) {
    const splicePath = {};
    const numToRemove = options.numToRemove || 0;
    const itemsToInsert = options.itemsToInsert || [];
    const lastIndex = path.length - 1;
    let currentPath = splicePath;

    path.forEach((index, i) => {
      if (i === lastIndex) {
        currentPath.$splice = [[index, numToRemove, ...itemsToInsert]];
      } else {
        const nextPath = {};
        currentPath[index] = { [options.childrenProp]: nextPath };
        currentPath = nextPath;
      }
    });

    return splicePath;
  }

  getRealNextPath(prevPath, nextPath) {
    const { childrenProp } = this.props;
    const ppLastIndex = prevPath.length - 1;
    const npLastIndex = nextPath.length - 1;

    if (prevPath.length < nextPath.length) {
      // move into deep
      let wasShifted = false;

      return nextPath.map((nextIndex, i) => {
        if (wasShifted) {
          return i == npLastIndex
            ? nextIndex + 1
            : nextIndex;
        }

        if (typeof prevPath[i] !== 'number') {
          return nextIndex;
        }

        if (nextPath[i] > prevPath[i] && i == ppLastIndex) {
          wasShifted = true;
          return nextIndex - 1;
        }

        return nextIndex;
      });

    } else if (prevPath.length == nextPath.length) {
      // if move bottom + move to item with children => make it a first child instead of swap
      if (nextPath[npLastIndex] > prevPath[npLastIndex]) {
        const target = this.getItemByPath(nextPath);

        if (target[childrenProp] && target[childrenProp].length && !this.isCollapsed(target)) {
          return nextPath
            .slice(0, -1)
            .concat(nextPath[npLastIndex] - 1)
            .concat(0);
        }
      }
    }

    return nextPath;
  }

  getItemOptions() {
    const { isDisabled, renderItem, renderCollapseIcon, handler, childrenProp } = this.props;
    const { dragItem } = this.state;

    return {
      dragItem,
      childrenProp,
      renderItem,
      renderCollapseIcon,
      handler,
      isDraggable: isDisabled ? false : true,

      onDragStart: this.onDragStart,
      onMouseEnter: this.onMouseEnter,
      isCollapsed: this.isCollapsed,
      onToggleCollapse: this.onToggleCollapse
    };
  }

  isCollapsed = (item) => {
    const { collapsed } = this.props;
    const { collapsedGroups } = this.state;

    return !!((collapsedGroups.indexOf(item.number) > -1) ^ collapsed);
  };

  // ––––––––––––––––––––––––––––––––––––
  // Click handlers or event handlers
  // ––––––––––––––––––––––––––––––––––––
  onDragStart = (e, item) => {
    if (this.props.isDisabled) return
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    this.el = closest(e.target, '.nestable-item');

    this.startTrackMouse();
    this.onMouseMove(e);

    this.setState({
      dragItem: item,
      itemsOld: this.state.items
    });
  };

  onDragEnd = (e, isCancel) => {
    if (this.props.isDisabled) return
    e && e.preventDefault();

    this.stopTrackMouse();
    this.el = null;

    isCancel
      ? this.dragRevert()
      : this.dragApply();
  };

  onMouseMove = (e) => {
    if (this.props.isDisabled) return
    const { group, threshold } = this.props;
    const { dragItem } = this.state;
    const { clientX, clientY } = e;
    const transformProps = getTransformProps(clientX, clientY);
    const elCopy = document.querySelector('.nestable-' + group + ' .nestable-drag-layer > .nestable-list');

    if (!this.elCopyStyles) {
      const offset = getOffsetRect(this.el);
      const scroll = getTotalScroll(this.el);

      this.elCopyStyles = {
        marginTop: offset.top - clientY - scroll.top,
        marginLeft: offset.left - clientX - scroll.left,
        ...transformProps
      };

    } else {
      this.elCopyStyles = {
        ...this.elCopyStyles,
        ...transformProps
      };
      for (let key in transformProps) {
        if (transformProps.hasOwnProperty(key)) {
          elCopy.style[key] = transformProps[key];
        }
      }

      const diffX = clientX - this.mouse.last.x;
      if (
        (diffX >= 0 && this.mouse.shift.x >= 0) ||
        (diffX <= 0 && this.mouse.shift.x <= 0)
      ) {
        this.mouse.shift.x += diffX;
      } else {
        this.mouse.shift.x = 0;
      }
      this.mouse.last.x = clientX;

      if (Math.abs(this.mouse.shift.x) > threshold) {
        if (this.mouse.shift.x > 0) {
          this.tryIncreaseDepth(dragItem);
        } else {
          this.tryDecreaseDepth(dragItem);
        }

        this.mouse.shift.x = 0;
      }
    }
  };

  onMouseEnter = (e, item) => {
    if (this.props.isDisabled) return
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    const { collapsed, childrenProp } = this.props;
    const { dragItem } = this.state;
    if (dragItem.number === item.number) return;

    const pathFrom = this.getPathById(dragItem.number);
    const pathTo = this.getPathById(item.number);

    // if collapsed by default
    // and move last (by count) child
    // remove parent node from list of open nodes
    let collapseProps = {};
    if (collapsed && pathFrom.length > 1) {
      const parent = this.getItemByPath(pathFrom.slice(0, -1));
      if (parent[childrenProp].length == 1) {
        collapseProps = this.onToggleCollapse(parent, true);
      }
    }

    this.moveItem({ dragItem, pathFrom, pathTo }, collapseProps);
  };

  onToggleCollapse = (item, isGetter) => {
    const { collapsed } = this.props;
    const { collapsedGroups } = this.state;
    const isCollapsed = this.isCollapsed(item);

    const newState = {
      collapsedGroups: (isCollapsed ^ collapsed)
        ? collapsedGroups.filter(number => number != item.number)
        : collapsedGroups.concat(item.number)
    };

    if (isGetter) {
      return newState;
    } else {
      this.props.onToggleCollapse(item.number, isCollapsed)
      this.setState(newState);
    }
  };

  onKeyDown = (e) => {
    if (this.props.isDisabled) return
    if (e.which === 27) {
      // ESC
      this.onDragEnd(null, true);
    }
  };

  // ––––––––––––––––––––––––––––––––––––
  // Render methods
  // ––––––––––––––––––––––––––––––––––––
  renderDragLayer() {
    if (this.props.isDisabled) return
    const { group } = this.props;
    const { dragItem } = this.state;
    const el = document.querySelector('.nestable-' + group + ' .nestable-item-' + dragItem.number);

    let listStyles = {};
    if (el) {
      listStyles.width = el.clientWidth;
    }
    if (this.elCopyStyles) {
      listStyles = {
        ...listStyles,
        ...this.elCopyStyles
      };
    }

    const options = this.getItemOptions();

    return (
      <div className="nestable-drag-layer">
        <ol className="nestable-list" style={listStyles}>
          <NestableItem
            item={dragItem}
            options={options}
            isCopy
          />
        </ol>
      </div>
    );
  }

  render() {
    const { items, dragItem } = this.state;
    const { group, isDisabled } = this.props;
    const options = this.getItemOptions();

    return (
      <div className={cn("nestable", "nestable-" + group, { 'is-drag-active': dragItem }, this.props.className, {'is-disabled': isDisabled})}>
        <ol className="nestable-list nestable-group">
          {items.map((item, i) => {
            return (
              <NestableItem
                key={i}
                index={i}
                item={item}
                options={options}
              />
            );
          })}
        </ol>

        {dragItem && this.renderDragLayer()}
      </div>
    );
  }
}

export default Nestable;
