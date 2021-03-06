var hostImg = 'statics/img/host.png';
var switchImg = 'statics/img/switch.png';
var portImg = 'statics/img/port.png';
var intfImg = 'statics/img/intf.png';
var vethImg = 'statics/img/veth.png';
var nsImg = 'statics/img/ns.png';
var bridgeImg = 'statics/img/bridge.png';
var dockerImg = 'statics/img/docker.png';
var neutronImg = 'statics/img/openstack.png';

var minusImg = 'statics/img/minus-outline-16.png';
var plusImg = 'statics/img/plus-16.png';
var captureIndicatorImg = 'statics/img/media-record.png';
var pinIndicatorImg = 'statics/img/pin.png';

var TopologyGraphLayout = function(vm, selector) {
  var self = this;

  this.vm = vm;

  this.initD3Data();

  this.handlers = [];

  this.queue = new Queue();
  this.queue.await(function() {
    if (self.invalid) self.update();
    self.invalid = false;
  }).start(100);

  this.width = $(selector).width() - 20;
  this.height = $(selector).height();

  this.simulation = d3.forceSimulation(Object.values(this.nodes))
    .force("charge", d3.forceManyBody().strength(-500))
    .force("link", d3.forceLink(Object.values(this.links)).distance(this.linkDistance).strength(0.9).iterations(2))
    .force("collide", d3.forceCollide().radius(80).strength(0.1).iterations(1))
    .force("center", d3.forceCenter(this.width / 2, this.height / 2))
    .force("x", d3.forceX(0).strength(0.01))
    .force("y", d3.forceY(0).strength(0.01))
    .alphaDecay(0.0090);

  this.zoom = d3.zoom()
    .on("zoom", this.zoomed.bind(this));

  this.svg = d3.select(selector).append("svg")
    .attr("width", this.width)
    .attr("height", this.height)
    .call(this.zoom)
    .on("dblclick.zoom", null);

  this.g = this.svg.append("g");

  this.group = this.g.append("g").attr('class', 'groups').selectAll(".group");
  this.link = this.g.append("g").attr('class', 'links').selectAll(".link");
  this.linkLabel = this.g.append("g").attr('class', 'link-labels').selectAll(".link-label");
  this.node = this.g.append("g").attr('class', 'nodes').selectAll(".node");

  this.simulation
    .on("tick", this.tick.bind(this));

  this.bandwidth = {
    bandwidthThreshold: 'absolute',
    updatePeriod: 3000,
    active: 5,
    warning: 100,
    alert: 1000,
    intervalID: null,
  };

  this.loadBandwidthConfig()
    .then(function() {
      self.bandwidth.intervalID = setInterval(self.updateBandwidth.bind(self), self.bandwidth.updatePeriod);
    });
};

TopologyGraphLayout.prototype = {

  notifyHandlers: function(ev, v1) {
    var self = this;

    this.handlers.forEach(function(h) {
      switch (ev) {
        case 'nodeSelected': h.onNodeSelected(v1); break;
      }
    });
  },

  addHandler: function(handler) {
    this.handlers.push(handler);
  },

  zoomIn: function() {
    this.svg.transition().duration(500).call(this.zoom.scaleBy, 1.1);
  },

  zoomOut: function() {
    this.svg.transition().duration(500).call(this.zoom.scaleBy, 0.9);
  },

  zoomFit: function() {
    var bounds = this.g.node().getBBox();
    var parent = this.g.node().parentElement;
    var fullWidth = parent.clientWidth, fullHeight = parent.clientHeight;
    var width = bounds.width, height = bounds.height;
    var midX = bounds.x + width / 2, midY = bounds.y + height / 2;
    if (width === 0 || height === 0) return;
    var scale = 0.75 / Math.max(width / fullWidth, height / fullHeight);
    var translate = [fullWidth / 2 - midX * scale, fullHeight / 2 - midY * scale];

    var t = d3.zoomIdentity
      .translate(translate[0] + 30, translate[1])
      .scale(scale);
      this.svg.transition().duration(500).call(this.zoom.transform, t);
  },

  initD3Data: function() {
    this.nodes = {};
    this._nodes = {};

    this.links = {};
    this._links = {};

    this.groups = [];
    this.collapseLevel = 0;

    this.linkLabels = {};

    this.collapsed = this.defaultCollpsed || false;
    this.selectedNode = null;
    this.invalid = false;
  },

  onPreInit: function() {
    this.queue.stop();
    this.queue.clear();

    this.initD3Data();
    this.update();
  },

  onPostInit: function() {
    var self = this;
    setTimeout(function() {
      self.queue.start(100);
    }, 1000);
  },

  linkDistance: function(e) {
    var distance = 100, coeff;
    if (e.source.group !== e.target.group) {
      if (e.source.isGroupOwner()) {
        coeff = e.source.group.collapsed ? 40 : 60;
        if (e.source.group.memberArray) {
          distance += coeff * (e.source.group.memberArray.length + e.source.group._memberArray.length) / 10;
        }
      }
      if (e.target.isGroupOwner()) {
        coeff = e.target.group.collapsed ? 40 : 60;
        if (e.target.group.memberArray) {
          distance += coeff * (e.target.group.memberArray.length + e.target.group._memberArray.length) / 10;
        }
      }
    }
    return distance;
  },

  hideNode: function(d) {
    if (this.hidden(d)) return;
    d.visible = false;

    delete this.nodes[d.id];
    this._nodes[d.id] = d;

    // remove links with neighbors
    if (d.links) {
      for (var i in d.links) {
        var link = d.links[i];

        if (this.links[link.id]) {
          delete this.links[link.id];
          this._links[link.id] = link;

          this.delLinkLabel(link);
        }
      }
    }

    var group = d.group, match = function(n) { return n !== d; };
    while(group && group.memberArray) {
      group.memberArray = group.memberArray.filter(match);
      if (group._memberArray.indexOf(d) < 0) group._memberArray.push(d);
      group = group.parent;
    }
  },

  hidden: function(d) {
    return d.metadata.Type === "ofrule";
  },

  showNode: function(d) {
    if (this.hidden(d)) return;
    d.visible = true;

    delete this._nodes[d.id];
    this.nodes[d.id] = d;

    var i, links = d.links;
    for (i in links) {
      var link = links[i];

      if (this._links[link.id] && link.source.visible && link.target.visible) {
        delete this._links[link.id];
        this.links[link.id] = link;
      }
    }

    var group = d.group, match = function(n) { return n !== d; };
    while(group && group.memberArray) {
      group._memberArray = group._memberArray.filter(match);
      if (group.memberArray.indexOf(d) < 0) group.memberArray.push(d);
      group = group.parent;
    }

    this.update();
  },

  onGroupAdded: function(group) {
    this.queue.defer(this._onGroupAdded.bind(this), group);
  },

  _onGroupAdded: function(group) {
    group.ownerType = group.owner.metadata.Type;
    group.level = 1;
    group.depth = 1;
    group.collapsed = this.collapsed;

    // list of all group and sub group members
    group.memberArray = [];
    group._memberArray = [];
    group.collapseLinks = [];

    this.groups.push(group);

    this.groupOwnerSet(group.owner);
  },

  delGroup: function(group) {
    var self = this;

    this.delCollapseLinks(group);

    this.groups = this.groups.filter(function(g) { return g.id !== group.id; });

    this.groupOwnerUnset(group.owner);
  },

  onGroupDeleted: function(group) {
    this.queue.defer(this._onGroupDeleted.bind(this), group);
  },

  _onGroupDeleted: function(group) {
    this.delGroup(group);
  },

  addGroupMember: function(group, node) {
    if (this.hidden(node)) return;

    while(group && group.memberArray) {
      if (node === group.owner) {
        if (group.memberArray.indexOf(node) < 0) group.memberArray.push(node);
      } else {
        var members = group.collapsed ? group._memberArray : group.memberArray;
        if (members.indexOf(node) < 0) members.push(node);
        if (node.group && group.collapsed) this.collapseNode(node, group);
      }
      group = group.parent;
    }
  },

  onGroupMemberAdded: function(group, node) {
    if (this.hidden(node)) return;
    this.queue.defer(this._onGroupMemberAdded.bind(this), group, node);
  },

  _onGroupMemberAdded: function(group, node) {
    this.addGroupMember(group, node);
  },

  delGroupMember: function(group, node) {
    var match = function(n) { return n !== node; };
    while(group && group.memberArray) {
      group.memberArray = group.memberArray.filter(match);
      group._memberArray = group._memberArray.filter(match);
      group = group.parent;
    }
  },

  onGroupMemberDeleted: function(group, node) {
    this.queue.defer(this._onGroupMemberDeleted.bind(this), group, node);
  },

  _onGroupMemberDeleted: function(group, node) {
    this.delGroupMember(group, node);
  },

  setGroupLevel: function(group) {
    var level = 1, g = group;
    while (g) {
      if (level > g.depth) g.depth = level;
      level++;

      g = g.parent;
    }
    group.level = level;
  },

  onParentSet: function(group) {
    this.queue.defer(this._onParentSet.bind(this), group);
  },

  _onParentSet: function(group) {
    var i;
    for (i = this.groups.length - 1; i >= 0; i--) {
      this.setGroupLevel(this.groups[i]);
    }
    this.groups.sort(function(a, b) { return a.level - b.level; });

    var members = Object.values(group.members);
    for (i = members.length - 1; i >= 0; i--) {
      this.addGroupMember(group.parent, members[i]);
    }
  },

  delLink: function(link) {
    delete this.links[link.id];
    delete this._links[link.id];

    this.delLinkLabel(link);
  },

  onEdgeAdded: function(link) {
    if (this.hidden(link.target) || this.hidden(link.source)) return;
    this.queue.defer(this._onEdgeAdded.bind(this), link);
  },

  hasOutsideLink: function(group) {
    var members = group.members;
    for (var i in members) {
      var d = members[i], edges = d.edges;
      for (var j in edges) {
        var e = edges[j];
        if (e.metadata.RelationType !== "ownership" && e.source.group !== e.source.target) return true;
      }
    }

    return false;
  },

  _onEdgeAdded: function(link) {
    link.source.links[link.id] = link;
    link.target.links[link.id] = link;

    if (link.metadata.RelationType === "ownership") {
      if (this.isNeutronRelatedVMNode(link.target)) return;

      if (link.target.metadata.Driver === "openvswitch" &&
          ["patch", "vxlan", "gre", "geneve"].indexOf(link.target.metadata.Type) >= 0) return;

      link.target.linkToParent = link;

      // do not add ownership link for groups having outside link
      if (link.target.isGroupOwner("ownership") && this.hasOutsideLink(link.target.group)) return;
    }

    var sourceGroup = link.source.group, targetGroup = link.target.group;
    if (targetGroup && targetGroup.type === "ownership" && this.hasOutsideLink(targetGroup) &&
        targetGroup.owner.linkToParent) this.delLink(targetGroup.owner.linkToParent);
    if (sourceGroup && sourceGroup.type === "ownership" && this.hasOutsideLink(sourceGroup) &&
        sourceGroup.owner.linkToParent) this.delLink(sourceGroup.owner.linkToParent);

    var i, noc, edges, metadata, source = link.source, target = link.target;
    if (Object.values(target.edges).length >= 2 && target.linkToParent) {
      noc = 0; edges = target.edges;
      for (i in edges) {
        metadata = edges[i].metadata;
        if (metadata.RelationType !== "ownership" && target.metadata.Type !== "bridge" && metadata.Type !== "vlan" && ++noc >= 2) this.delLink(target.linkToParent);
      }
    }
    if (Object.keys(source.edges).length >= 2 && source.linkToParent) {
      noc = 0; edges = link.source.edges;
      for (i in edges) {
        metadata = edges[i].metadata;
        if (metadata.RelationType !== "ownership" && source.metadata.Type !== "bridge" && metadata.Type !== "vlan" && ++noc >= 2) this.delLink(source.linkToParent);
      }
    }

    if (!source.visible && !target.visible) {
      this._links[link.id] = link;
      if (source.group !== target.group && source.group.owner.visible && target.group.owner.visible) {
        this.addCollapseLink(source.group, source.group.owner, target.group.owner, link.metadata);
      }
    } else if (!source.visible) {
      this._links[link.id] = link;
      if (source.group && source.group.collapsed && source.group != target.group) {
        this.addCollapseLink(source.group, source.group.owner, target, link.metadata);
      }
    } else if (!target.visible) {
      this._links[link.id] = link;
      if (target.group && target.group.collapsed && source.group != target.group) {
        this.addCollapseLink(target.group, target.group.owner, source, link.metadata);
      }
    } else {
      this.links[link.id] = link;
    }

    // invalid the current graph
    this.invalid = true;
  },

  onEdgeDeleted: function(link) {
    if (this.hidden(link.target) || this.hidden(link.source)) return;
    this.queue.defer(this._onEdgeDeleted.bind(this), link);
  },

  _onEdgeDeleted: function(link) {
    this.delLink(link);

    this.invalid = true;
  },

  onNodeAdded: function(node) {
    if (this.hidden(node)) return;
    this.queue.defer(this._onNodeAdded.bind(this), node);
  },

  _onNodeAdded: function(node) {
    node.visible = true;
    if (!node.links) node.links = {};
    node._metadata = node.metadata;

    this.nodes[node.id] = node;

    this.invalid = true;
  },

  delNode: function(node) {
    if (this.selectedNode === node) this.selectedNode = null;

    delete this.nodes[node.id];
    delete this._nodes[node.id];

    if (node.group) this.delGroupMember(node.group, node);

    for (var i in node.links) {
      var link = node.links[i];

      if (link.collapse) this.delCollapseLinks(link.collapse.group, node);
    }
  },

  onNodeDeleted: function(node) {
    if (this.hidden(node)) return;
    this.queue.defer(this._onNodeDeleted.bind(this), node);
  },

  _onNodeDeleted: function(node) {
    this.delNode(node);

    this.invalid = true;
  },

  onNodeUpdated: function(node) {
    if (this.hidden(node)) return;
    this.queue.defer(this._onNodeUpdated.bind(this), node);
  },

  _onNodeUpdated: function(node) {
    if (this.isNeutronRelatedVMNode(node)) {
      for (var i in node.links) {
        var link = node.links[i];
        if (link.metadata.RelationType === "ownership" && this.links[link.id]) {
          delete this.links[link.id];
          this.invalid = true;
        }
      }
    }
    if (node.metadata.Capture && !node._metadata.Capture) {
      this.captureStarted(node);
    } else if (!node.metadata.Capture && node._metadata.Capture) {
      this.captureStopped(node);
    }
    if (node.metadata.Manager && !node._metadata.Manager) {
      this.managerSet(node);
    }
    if (node.metadata.State !== node._metadata.State) {
       this.stateSet(node);
    }
    node._metadata = node.metadata;
  },

  zoomed: function() {
    this.g.attr("transform", d3.event.transform);
  },

  cross: function(a, b, c)  {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  },

  computeUpperHullIndexes: function(points) {
    var i, n = points.length, indexes = [0, 1], size = 2;

    for (i = 2; i < n; ++i) {
      while (size > 1 && this.cross(points[indexes[size - 2]], points[indexes[size - 1]], points[i]) <= 0) --size;
      indexes[size++] = i;
    }

    return indexes.slice(0, size);
  },

  // see original d3 implementation
  convexHull: function(group) {
    var members = group.memberArray, n = members.length;
    if (n < 1) return null;

    if (n == 1) {
      return members[0].x && members[0].y ? [[members[0].x, members[0].y], [members[0].x + 1, members[0].y + 1]] : null;
    }

    var i, node, sortedPoints = [], flippedPoints = [];
    for (i = 0; i < n; ++i) {
      node = members[i];
      if (node.x && node.y) sortedPoints.push([node.x, node.y, i]);
    }
    sortedPoints.sort(function(a, b) {
      return a[0] - b[0] || a[1] - b[1];
    });
    for (i = 0; i < sortedPoints.length; ++i) {
      flippedPoints[i] = [sortedPoints[i][0], -sortedPoints[i][1]];
    }

    var upperIndexes = this.computeUpperHullIndexes(sortedPoints),
        lowerIndexes = this.computeUpperHullIndexes(flippedPoints);

    var skipLeft = lowerIndexes[0] === upperIndexes[0],
        skipRight = lowerIndexes[lowerIndexes.length - 1] === upperIndexes[upperIndexes.length - 1],
        hull = [];

    for (i = upperIndexes.length - 1; i >= 0; --i) {
        node = members[sortedPoints[upperIndexes[i]][2]];
        hull.push([node.x, node.y]);
    }
    for (i = +skipLeft; i < lowerIndexes.length - skipRight; ++i) {
      node = members[sortedPoints[lowerIndexes[i]][2]];
      hull.push([node.x, node.y]);
    }

    return hull;
  },

  tick: function() {
    var self = this;

    this.link.attr("d", function(d) { if (d.source.x && d.target.x) return 'M ' + d.source.x + " " + d.source.y + " L " + d.target.x + " " + d.target.y; });
    this.linkLabel.attr("transform", function(d, i){
        if (d.link.target.x < d.link.source.x){
          var bbox = this.getBBox();
          var rx = bbox.x + bbox.width / 2;
          var ry = bbox.y + bbox.height / 2;
          return "rotate(180 " + rx + " " + ry +")";
        }
        else {
          return "rotate(0)";
        }
    });

    this.node.attr("transform", function(d) { return "translate(" + d.x + "," + d.y + ")"; });

    this.group.attrs(function(d) {
      if (d.type !== "ownership") return;

      var hull = self.convexHull(d);

      if (hull && hull.length) {
        return {
          'd': hull ? "M" + hull.join("L") + "Z" : d.d,
          'stroke-width': 64 + d.depth * 50,
        };
      } else {
        return { 'd': '' };
      }
    });
  },

  onNodeDragStart: function(d) {
    if (!d3.event.active) this.simulation.alphaTarget(0.05).restart();

    if (d3.event.sourceEvent.shiftKey && d.isGroupOwner()) {
      var i, members = d.group.memberArray.concat(d.group._memberArray);
      for (i = members.length - 1; i >= 0; i--) {
        members[i].fx = members[i].x;
        members[i].fy = members[i].y;
      }
    } else {
      d.fx = d.x;
      d.fy = d.y;
    }
  },

  onNodeDrag: function(d) {
    var dx = d3.event.x - d.fx, dy = d3.event.y - d.fy;

    if (d3.event.sourceEvent.shiftKey && d.isGroupOwner()) {
      var i, members = d.group.memberArray.concat(d.group._memberArray);
      for (i = members.length - 1; i >= 0; i--) {
        members[i].fx += dx;
        members[i].fy += dy;
      }
    } else {
      d.fx += dx;
      d.fy += dy;
    }
  },

  onNodeDragEnd: function(d) {
    if (!d3.event.active) this.simulation.alphaTarget(0);

    if (d.isGroupOwner()) {
      var i, members = d.group.memberArray.concat(d.group._memberArray);
      for (i = members.length - 1; i >= 0; i--) {
        if (!members[i].fixed) {
          members[i].fx = null;
          members[i].fy = null;
        }
      }
    } else {
      if (!d.fixed) {
        d.fx = null;
        d.fy = null;
      }
    }
  },

  stateSet: function(d) {
    this.g.select("#node-" + d.id).attr("class", this.nodeClass);
  },

  managerSet: function(d) {
    var size = this.nodeSize(d);
    var node = this.g.select("#node-" + d.id);

    node.append("circle")
    .attr("class", "manager")
    .attr("r", 12)
    .attr("cx", size - 2)
    .attr("cy", size - 2);

    node.append("image")
      .attr("class", "manager")
      .attr("x", size - 12)
      .attr("y", size - 12)
      .attr("width", 20)
      .attr("height", 20)
      .attr("xlink:href", this.managerImg(d));
  },

  isNeutronRelatedVMNode: function(d) {
    return d.metadata.Manager === "neutron" && ["tun", "veth", "bridge"].includes(d.metadata.Driver);
  },

  captureStarted: function(d) {
    var size = this.nodeSize(d);
    this.g.select("#node-" + d.id).append("image")
      .attr("class", "capture")
      .attr("x", -size - 8)
      .attr("y", size - 8)
      .attr("width", 16)
      .attr("height", 16)
      .attr("xlink:href", captureIndicatorImg);
  },

  captureStopped: function(d) {
    this.g.select("#node-" + d.id).select('image.capture').remove();
  },

  groupOwnerSet: function(d) {
    var self = this;

    var o = this.g.select("#node-" + d.id);

    o.append("image")
    .attr("class", "collapsexpand")
    .attr("width", 16)
    .attr("height", 16)
    .attr("x", function(d) { return -self.nodeSize(d) - 4; })
    .attr("y", function(d) { return -self.nodeSize(d) - 4; })
    .attr("xlink:href", this.collapseImg);
    o.select('circle').attr("r", this.nodeSize);
  },

  groupOwnerUnset: function(d) {
    var o = this.g.select("#node-" + d.id);
    o.select('image.collapsexpand').remove();
    o.select('circle').attr("r", this.nodeSize);
  },

  pinNode: function(d) {
    var size = this.nodeSize(d);
    this.g.select("#node-" + d.id).append("image")
      .attr("class", "pin")
      .attr("x", size - 12)
      .attr("y", -size - 4)
      .attr("width", 16)
      .attr("height", 16)
      .attr("xlink:href", pinIndicatorImg);
    d.fixed = true;
    d.fx = d.x;
    d.fy = d.y;
  },

  unpinNode: function(d) {
    this.g.select("#node-" + d.id).select('image.pin').remove();
    d.fixed = false;
    d.fx = null;
    d.fy = null;
  },

  onNodeShiftClick: function(d) {
    if (!d.fixed) {
      this.pinNode(d);
    } else {
      this.unpinNode(d);
    }
  },

  selectNode: function(d) {
    circle = this.g.select("#node-" + d.id)
      .classed('selected', true)
      .select('circle');
    circle.transition().duration(500).attr('r', +circle.attr('r') + 3);
    d.selected = true;
    this.selectedNode = d;
  },

  unselectNode: function(d) {
    circle = this.g.select("#node-" + d.id)
      .classed('selected', false)
      .select('circle');
    if (!circle) return;
    circle.transition().duration(500).attr('r', circle ? +circle.attr('r') - 3 : 0);
    d.selected = false;
    this.selectedNode = null;
  },

  onNodeClick: function(d) {
    if (d3.event.shiftKey) return this.onNodeShiftClick(d);
    if (d3.event.altKey) return this.collapseByNode(d);

    if (this.selectedNode === d) return;

    if (this.selectedNode) this.unselectNode(this.selectedNode);
    this.selectNode(d);

    this.notifyHandlers('nodeSelected', d);
  },

  addCollapseLink: function(group, source, target, metadata) {
    var id = source.id < target.id ? source.id + '-' + target.id : target.id + '-' + source.id;
    if (!this.links[id]) {
      var link = {
        id: id,
        source: source,
        target: target,
        metadata: metadata,
        collapse: {
          group: group
        }
      };
      group.collapseLinks.push(link);

      if (!source.links) source.links = {};
      source.links[id] = link;

      if (!target.links) target.links = {};
      target.links[id] = link;

      this.links[id] = link;
    }
  },

  delCollapseLinks: function(group, node) {
    var i, e, cl = [];
    for (i = group.collapseLinks.length - 1; i >= 0; i--) {
      e = group.collapseLinks[i];
      if (!node || e.source === node || e.target === node) {
        this.delLink(e);
      } else {
        cl.push(e);
      }
    }
    group.collapseLinks = cl;
  },

  collapseNode: function(n, group) {
    if (n === group.owner) return;

    var i, e, source, target, edges = n.edges,
        members = group.memberArray.concat(group._memberArray);
    for (i in edges) {
      e = edges[i];

      if (e.metadata.RelationType === "ownership") continue;

      if (members.indexOf(e.source) < 0 || members.indexOf(e.target) < 0) {
        source = e.source; target = e.target;
        if (e.source.group === group) {
          // group already collapsed, link owners together, delete old collapse links
          // that were present between these two groups
          if (e.target.group && e.target.group.collapsed) {
            this.delCollapseLinks(e.target.group, source);
            target = e.target.group.owner;
          }
          source = group.owner;
        } else {
          // group already collapsed, link owners together, delete old collapse links
          // that were present between these two groups
          if (e.source.group && e.source.group.collapsed) {
            this.delCollapseLinks(e.source.group, target);
            source = e.source.group.owner;
          }
          target = group.owner;
        }

        if (!source.group || !target.group || (source.group.owner.visible && target.group.owner.visible)) {
          this.addCollapseLink(group, source, target, e.metadata);
        }
      }
    }

    this.hideNode(n);
  },

  collapseGroup: function(group) {
    var i, children = group.children;
    for (i in children) {
      if (children[i].collapsed) this.uncollapseGroup(children[i]);
    }

    for (i = group.memberArray.length - 1; i >= 0; i--) {
      this.collapseNode(group.memberArray[i], group);
    }
    group.collapsed = true;

    this.g.select("#node-" + group.owner.id)
      .attr('collapsed', group.collapsed)
      .select('image.collapsexpand')
      .attr('xlink:href', this.collapseImg);
  },

  uncollapseNode: function(n, group) {
    if (n === group.owner) return;

    var i, e, link, source, target, edges = n.edges;
        members = group.memberArray.concat(group._memberArray);
    for (i in edges) {
      e = edges[i];

      if (e.metadata.RelationType === "ownership") continue;

      if (members.indexOf(e.source) < 0 || members.indexOf(e.target) < 0) {
        source = e.source; target = e.target;
        if (source.group === group) {
          this.delCollapseLinks(target.group, group.owner);

          if (target.group.collapsed) {
            this.addCollapseLink(group, source, target.group.owner, e.metadata);
          }
        } else if (source.group) {
          this.delCollapseLinks(source.group, group.owner);

          if (source.group.collapsed) {
            this.addCollapseLink(group, source.group.owner, target, e.metadata);
          }
        }
      }
    }

    this.showNode(n);
  },

  uncollapseGroupTree: function(group) {
    this.delCollapseLinks(group);

    var i;
    for (i = group._memberArray.length -1; i >= 0; i--) {
      this.uncollapseNode(group._memberArray[i], group);
    }
    group.collapsed = false;

    var children = group.children;
    for (i in children) {
      this.uncollapseGroupTree(children[i]);
    }
    this.g.select("#node-" + group.owner.id)
      .attr('collapsed', group.collapsed)
      .select('image.collapsexpand')
      .attr('xlink:href', this.collapseImg);
  },

  collapseGroupTree: function(group) {
    var i, children = group.children;
    for (i in children) {
      if (children[i].collapsed) this.collapseGroupTree(children[i]);
    }

    for (i = group.memberArray.length - 1; i >= 0; i--) {
      this.collapseNode(group.memberArray[i], group);
    }
    group.collapsed = true;

    this.g.select("#node-" + group.owner.id)
      .attr('collapsed', group.collapsed)
      .select('image.collapsexpand')
      .attr('xlink:href', this.collapseImg);
  },

  uncollapseGroup: function(group) {
    this.delCollapseLinks(group);

    var i;
    for (i = group._memberArray.length - 1; i >= 0; i--) {
      this.uncollapseNode(group._memberArray[i], group);
    }
    group.collapsed = false;

    // collapse children
    var children = group.children;
    for (i in children) {
      this.collapseGroup(children[i]);
    }

    this.g.select("#node-" + group.owner.id)
      .attr('collapsed', group.collapsed)
      .select('image.collapsexpand')
      .attr('xlink:href', this.collapseImg);
  },

  toggleExpandAll: function(d) {
    if (d.isGroupOwner()) {
      if(!d.group.collapsed) {
        this.collapseGroupTree(d.group);
      } else {
        this.uncollapseGroupTree(d.group);
      }
    }
    this.update();
  },

  collapseByNode: function(d) {
    if (d.isGroupOwner()) {
      if (!d.group.collapsed) {
        this.collapseGroup(d.group);
      } else {
        this.uncollapseGroup(d.group);
      }
    }

    this.update();
  },

  collapse: function(collapse) {
    this.collapsed = collapse;
    this.defaultCollpsed = collapse;

    var i;
    for (i = this.groups.length - 1; i >= 0; i--) {
      if (collapse) {
        this.collapseGroup(this.groups[i]);
      } else if (!this.groups[i].parent) {
        this.uncollapseGroup(this.groups[i]);
      }
    }

    this.update();
  },

  toggleCollapseByLevel: function(collapse) {
    if (collapse) {
      if (this.collapseLevel === 0) {
        return;
      } else {
        this.collapseLevel--;
      }
      this.collapseByLevel(this.collapseLevel, collapse, this.groups);
    } else {
      var maxLevel = 0;
      for (var i in this.groups) {
        var group = this.groups[i];
        if (group.level > maxLevel) maxLevel = group.level;
      }
      if (maxLevel > 1 && (this.collapseLevel + 1) >= maxLevel) {
        return;
      }

      this.collapseByLevel(this.collapseLevel, collapse, this.groups);
      this.collapseLevel++;
    }
  },

  collapseByLevel: function(level, collapse, groups) {
    var i;
    if (level === 0) {
      for (i = groups.length - 1; i >= 0; i--) {
        if (collapse) {
          this.collapseGroup(groups[i]);
        } else {
          this.uncollapseGroup(groups[i]);
        }
      }
      this.update();
    } else {
      for (i = groups.length - 1; i >= 0; i--) {
        this.collapseByLevel((level-1), collapse, Object.values(groups[i].children));
      }
    }
  },

  loadBandwidthConfig: function() {
    var vm = this.vm, b = this.bandwidth;

    var cfgNames = {
      relative: ['analyzer.bandwidth_relative_active',
                 'analyzer.bandwidth_relative_warning',
                 'analyzer.bandwidth_relative_alert'],
      absolute: ['analyzer.bandwidth_absolute_active',
                 'analyzer.bandwidth_absolute_warning',
                 'analyzer.bandwidth_absolute_alert']
     };

    return $.when(
        vm.$getConfigValue('analyzer.bandwidth_update_rate'),
        vm.$getConfigValue('analyzer.bandwidth_source'),
        vm.$getConfigValue('analyzer.bandwidth_threshold'))
      .then(function(period, src, threshold) {
        b.updatePeriod = period[0] * 1000; // in millisec
        b.bandwidth_threshold = threshold[0];
        return b.bandwidth_threshold;
      })
    .then(function(t) {
      return $.when(
        vm.$getConfigValue(cfgNames[t][0]),
        vm.$getConfigValue(cfgNames[t][1]),
        vm.$getConfigValue(cfgNames[t][2]))
        .then(function(active, warning, alert) {
          b.active = active[0];
          b.warning = warning[0];
          b.alert = alert[0];
        });
    });
  },

  bandwidthFromMetrics: function(metrics) {
    if (!metrics) return;

    var totalByte = metrics.RxBytes + metrics.TxBytes;
    var deltaTime = metrics.Last - metrics.Start;

    deltaTime = Math.floor(deltaTime / 1000); // ms to sec
    if (deltaTime >= 1 && totalByte >= 1) {
      return Math.floor(8 * totalByte / (1024 * deltaTime)); // to kbit per sec
    }
    return 0;
  },

  updateBandwidth: function() {
    var bandwidth = this.bandwidth, defaultInterfaceSpeed = 1048576;

    var i, link, links = this.links;
    for (i in links) {
      link = links[i];

      if (link.metadata.RelationType != "layer2" || !link.target.metadata.LastMetric) continue;
      if (!link.source.visible || !link.target.visible) continue;

      var speed = (this.bandwidth.bandwidthThreshold === 'relative') ?
        link.target.metadata.Speed || defaultInterfaceSpeed : 1;

      var kbps = this.bandwidthFromMetrics(link.target.metadata.LastMetric);
      if (link.target.metadata.LastMetric && kbps > bandwidth.active * speed) {
        this.linkLabels[link.id] = {
          id: "link-label-" + link.id,
          link: link,
          text: bandwidthToString(kbps)
        };

        this.linkLabel = this.linkLabel.data(Object.values(this.linkLabels), function(d) { return d.id; });
        this.linkLabel.exit().remove();

        var linkLabelEnter = this.linkLabel.enter()
          .append('text')
          .attr("id", "link-label-" + link.id)
          .attr("class", "link-label");
        linkLabelEnter.append('textPath')
          .attr("startOffset", "50%")
          .attr("xlink:href", "#link-" + link.id);

        this.linkLabel = linkLabelEnter.merge(this.linkLabel);

        this.linkLabel.select('textPath')
          .classed ("link-label-active", (kbps > bandwidth.active * speed) && (kbps < bandwidth.warning * speed))
          .classed ("link-label-warning", (kbps >= bandwidth.warning * speed) && (kbps < bandwidth.alert * speed))
          .classed ("link-label-alert", kbps >= bandwidth.alert * speed)
          .text(function(d) { return d.text; });

        // force a tick
        this.tick();
      } else {
        this.delLinkLabel(link);
      }
    }
  },

  delLinkLabel: function(link) {
    if (!(link.id in this.linkLabels)) return;

    delete this.linkLabels[link.id];

    this.linkLabel = this.linkLabel.data(Object.values(this.linkLabels), function(d) { return d.id; });
    this.linkLabel.exit().remove();
  },

  update: function() {
    var self = this;

    var nodes = Object.values(this.nodes), links = Object.values(this.links);

    this.node = this.node.data(nodes, function(d) { return d.id; });
    this.node.exit().remove();

    var nodeEnter = this.node.enter()
      .append("g")
      .attr("class", this.nodeClass)
      .attr("id", function(d) { return "node-" + d.id; })
      .on("click", this.onNodeClick.bind(this))
      .on("dblclick", this.collapseByNode.bind(this))
      .call(d3.drag()
        .on("start", this.onNodeDragStart.bind(this))
        .on("drag", this.onNodeDrag.bind(this))
        .on("end", this.onNodeDragEnd.bind(this)));

    nodeEnter.append("circle")
      .attr("r", this.nodeSize);

    // node picto
    nodeEnter.append("image")
      .attr("id", function(d) { return "node-img-" + d.id; })
      .attr("class", "picto")
      .attr("x", -12)
      .attr("y", -12)
      .attr("width", "24")
      .attr("height", "24")
      .attr("xlink:href", this.nodeImg);

    // node title
    nodeEnter.append("text")
      .attr("dx", function(d) {
        return self.nodeSize(d) + 5;
      })
      .attr("dy", 10)
      .text(this.nodeTitle);

    nodeEnter.filter(function(d) { return d.isGroupOwner(); })
      .each(this.groupOwnerSet.bind(this));

    nodeEnter.filter(function(d) { return d.metadata.Capture; })
      .each(this.captureStarted.bind(this));

    nodeEnter.filter(function(d) { return d.metadata.Manager; })
      .each(this.managerSet.bind(this));

    this.node = nodeEnter.merge(this.node);

    this.link = this.link.data(links, function(d) { return d.id; });
    this.link.exit().remove();

    var linkEnter = this.link.enter()
      .append("path")
      .attr("class", this.linkClass)
      .attr("id", function(d) { return "link-" + d.id; });

    this.link = linkEnter.merge(this.link);

    this.group = this.group.data(this.groups, function(d) { return d.id; });
    this.group.exit().remove();

    var groupEnter = this.group.enter()
      .append("path")
      .attr("class", this.groupClass)
      .attr("id", function(d) { return "group-" + d.id; });

    this.group = groupEnter.merge(this.group).order();

    this.simulation.nodes(nodes);
    this.simulation.force("link").links(links);
    this.simulation.alpha(1).restart();
  },

  groupClass: function(d) {
    var clazz = "group " + d.ownerType;

    if (d.owner.metadata.Probe) clazz += " " + d.owner.metadata.Probe;

    return clazz;
  },

  highlightNodeID: function(id, s) {
    this.g.select("#node-" + id).classed('highlighted', true);
  },

  unhighlightNodeID: function(id, s) {
    this.g.select("#node-" + id).classed('highlighted', false);
  },

  nodeClass: function(d) {
    var clazz = "node " + d.metadata.Type;

    if (d.metadata.Probe) clazz += " " + d.metadata.Probe;
    if (d.metadata.State == "DOWN") clazz += " down";
    if (d.highlighted) clazz += " highlighted";
    if (d.selected) clazz += " selected";

    return clazz;
  },

  linkClass: function(d) {
    var clazz = "link " + d.metadata.RelationType;

    if (d.metadata.Type) clazz += " " + d.metadata.Type;

    return clazz;
  },

  nodeTitle: function(d) {
    if (d.metadata.Type === "host") {
      return d.metadata.Name.split(".")[0];
    }
    return d.metadata.Name ? d.metadata.Name.length > 12 ? d.metadata.Name.substr(0, 12)+"..." : d.metadata.Name : "";
  },

  nodeSize: function(d) {
    var size;
    switch(d.metadata.Type) {
      case "host": size = 30; break;
      case "netns": size = 26; break;
      case "port":
      case "ovsport": size = 22; break;
      case "switch":
      case "ovsbridge": size = 24; break;
      default:
        size = d.isGroupOwner() ? 26 : 20;
    }
    if (d.selected) size += 3;

    return size;
  },

  nodeImg: function(d) {
    switch(d.metadata.Type) {
      case "host": return hostImg;
      case "port":
      case "ovsport": return portImg;
      case "bridge": return bridgeImg;
      case "switch":
      case "ovsbridge": return switchImg;
      case "netns": return nsImg;
      case "veth": return vethImg;
      case "bond": return portImg;
      case "container": return dockerImg;
      default: return intfImg;
    }
  },

  managerImg: function(d) {
    switch(d.metadata.Manager) {
      case "docker": return dockerImg;
      case "neutron": return neutronImg;
    }
  },

  collapseImg: function(d) {
    if (d.group && d.group.collapsed) return plusImg;
    return minusImg;
  }

};
