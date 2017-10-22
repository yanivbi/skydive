/*
 * Copyright 2016 IBM Corp.
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */

package probes

import (
	"fmt"
	"strings"
        "time"
	"sort"

	"github.com/skydive-project/skydive/logging"
	"github.com/skydive-project/skydive/topology/graph"
	"github.com/skydive-project/skydive/config"

	"github.com/FlorianOtel/client-go/kubernetes"
	"github.com/FlorianOtel/client-go/pkg/api/v1"
	"github.com/FlorianOtel/client-go/tools/clientcmd"
	"github.com/FlorianOtel/client-go/pkg/types"
	"reflect"
)

type k8sNP struct {
	from graph.Identifier
	to graph.Identifier
	m graph.Metadata
	fromStr string // for sorting
	toStr string // for sorting
	direction string
	npText string
	e graph.Identifier
}

type K8SCtlMessage struct {
	msgType string
	obj     interface{}
}

type k8sPodEdge struct {
	Valid	bool
	Name 	string
	GraphNode	graph.Identifier // skydive
}


type k8sPodsStruct struct {
	Name 	string
	GraphNode	graph.Identifier // skydive
	Namespace string
	UID	types.UID // k8s
	Labels 	map[string]string
	Hostname string
}

type K8SCtlProbe struct {
	Graph           *graph.Graph
	nodeUpdaterChan chan graph.Identifier
	messagesUpdaterChan chan K8SCtlMessage
	NetnsIDs 	    map[interface{}]graph.Identifier
	k8sPods		map[string]k8sPodsStruct
	k8sNP_NEW 	[]k8sNP
	k8sNP_OLD 	[]k8sNP
}

func valueToStringGenerated(v interface{}) string {
	rv := reflect.ValueOf(v)
	if rv.IsNil() {
		return "nil"
	}
	pv := reflect.Indirect(rv).Interface()
	return fmt.Sprintf("*%v", pv)
}

func (k8s *K8SCtlProbe) isNSExist(nodeName interface{}) bool {
	for name := range k8s.NetnsIDs{
		if name.(string)==nodeName.(string){
			return true
		}
	}
	return false
}

func (k8s *K8SCtlProbe) Updatek8sNP() {
	t := config.GetConfig().GetDuration("k8s.polling_rate")
	logging.GetLogger().Infof("Update every %s\n",t)
	for {
		k8s.k8sNP_OLD = make([]k8sNP, 50) //TODO: increase size ?
		k8s.k8sNP_OLD = k8s.k8sNP_NEW
		k8s.k8sNP_NEW = make([]k8sNP, 50) //TODO: increase size ?

		k8s.Getk8sPods()
		k8s.syncWithK8s()
		k8s.Getk8sNP()
		// TODO: can be done more efficiently by adding unique ID (or pointer) to each k8s.k8sNP_NEW entry, and maintain separated data structure for *Edge.
		k8s.CopyEdgePointers() // CopyEdgesPointers from k8s.k8sNP_OLD to NEW
		k8s.UpdateNPLinks()
 		time.Sleep(t)
	 }
}

// Copy corresponding *Edge to each Link (*Edge is assigned to k8s.k8sNP_NEW by k8s.UpdateNPLinks() only when the Edge is first added
// Need to preserve it when updating k8s.k8sNP_OLD/NEW ...
func (k8s *K8SCtlProbe) CopyEdgePointers(){
	for i,link := range k8s.k8sNP_NEW{
		if (link.from=="" || link.to == ""){
			break
		}
		edge := k8s.findEdge(link)
		if edge != "" {
			k8s.k8sNP_NEW[i].e=edge
		}
	}
}

// retrun *Edge of NP link is exist
func (k8s *K8SCtlProbe) findEdge(link k8sNP) graph.Identifier{
	for _, linkOLD := range k8s.k8sNP_OLD{
		if (linkOLD.from==link.from && linkOLD.to==link.to){
			return linkOLD.e
		}
	}
	return ""
}

// removes all k8s np edges
func (k8s *K8SCtlProbe) DeleteNSEdges() {
	m := graph.Metadata{}
	edges := k8s.Graph.GetEdges(m)

	for _,edge := range edges{
		if edge.Metadata()["Application"] == "k8s" && edge.Metadata()["LinkType"]=="k8s policy"{
			k8s.Graph.Lock()
			k8s.Graph.DelEdge(edge)
			k8s.Graph.Unlock()
			logging.GetLogger().Debugf("Removed Edge %s->%s (%s)\n",edge.Metadata()["From"],edge.Metadata()["To"],edge.Metadata()["NetworkPolicy"])
		}
	}
}

// retrun the skydive ID of the matched pod according to given namespace
func (k8s *K8SCtlProbe) FindPodByNS(ns string) (bool, []k8sPodEdge){
	var ret []k8sPodEdge
	var valid bool = false
	for name, data := range k8s.k8sPods {
		if data.Namespace == ns {
			var pod k8sPodEdge
			pod.Valid = true
			pod.GraphNode = data.GraphNode
			pod.Name = name
			ret = append(ret, pod)
			valid = true
		}
	}
	return valid, ret
}


// retrun the skydive ID of the matched pod according to given label key/value
func (k8s *K8SCtlProbe) FindPodByLabel(key string, value string, ns string) (k8sPodEdge){
	for name, data := range k8s.k8sPods {
		labels := data.Labels
		if labels[key] == value {
			if ns != "" {
				if data.Namespace == ns {
					var ret k8sPodEdge
					ret.Valid = true
					ret.GraphNode = data.GraphNode
					ret.Name = name
					return ret
				}
			}else {
				var ret k8sPodEdge
				ret.Valid = true
				ret.GraphNode = data.GraphNode
				ret.Name = name
				return ret
			}
		}
	}
	var ret k8sPodEdge
	ret.Valid = false
	return ret
}

// sync between pods (k8s.k8sPods) as reported by k8s and skydive netns IDs (k8s.NetnsIDs)
func (k8s *K8SCtlProbe) syncWithK8s(){
	for name, data := range k8s.k8sPods{
		// match name with k8s.NetnsIDs val
		for key,val := range k8s.NetnsIDs{
			uid := data.UID
			if strings.Contains(key.(string), string(uid)) {
				// update k8sPods
				data.GraphNode = val
				k8s.k8sPods[name] = data
				logging.GetLogger().Debugf("Update pod %s with ID %s \n", name, data.GraphNode)
			}
		}
	}
}

// gets pods from k8s
func (k8s *K8SCtlProbe) Getk8sPods() bool {

	kubeconfig := config.GetConfig().GetString("k8s.config_file")
	// uses the current context in kubeconfig
	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		panic(err.Error())
	}
	// creates the clientset
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		panic(err.Error())
	}

	pods, err := clientset.Core().Pods("").List(v1.ListOptions{})
	if err != nil {
		panic(err.Error())
	}
	logging.GetLogger().Debugf("There are %d pods in the cluster\n", len(pods.Items))
	if (len(pods.Items) == 0) {
		logging.GetLogger().Debugf("There are no k8s pods - skipping \n")
		return false
	}

	for _, pod := range pods.Items {
		logging.GetLogger().Debugf("%s %s %s\n", pod.GetName(), pod.GetCreationTimestamp(), pod.GetUID())
		if val, ok := k8s.k8sPods[pod.GetName()]; ok {
		    	// update
			val.Namespace = pod.GetNamespace()
			val.UID = pod.GetUID()
			val.Labels = pod.GetLabels()
			val.Hostname = pod.Spec.Hostname
			k8s.k8sPods[pod.GetName()] = val
		} else {
			// new
			val := k8sPodsStruct{Namespace: pod.GetNamespace(), UID: pod.GetUID(), Labels: pod.GetLabels(), Hostname: pod.Spec.Hostname, GraphNode: ""} // TODO: there is also pod.Spec.NodeName
			k8s.k8sPods[pod.GetName()] = val
		}
	}
	return true
}

// Update NP links (add/remove)
func (k8s *K8SCtlProbe) UpdateNPLinks(){

	sort.Slice(k8s.k8sNP_NEW, func(i, j int) bool {
		return strings.Join([]string{k8s.k8sNP_NEW[i].fromStr,k8s.k8sNP_NEW[i].toStr},"") > strings.Join([]string{k8s.k8sNP_NEW[j].fromStr,k8s.k8sNP_NEW[j].toStr},"")
	})
	logging.GetLogger().Debugf("Is equal (OLD/NEW) = %s\n",reflect.DeepEqual(k8s.k8sNP_OLD,k8s.k8sNP_NEW))
	if !reflect.DeepEqual(k8s.k8sNP_OLD,k8s.k8sNP_NEW){
		var old int = 0
		var new int = 0
		logging.GetLogger().Debugf("k8sCtl prob: OLD %s \n",k8s.k8sNP_OLD)
		logging.GetLogger().Debugf("k8sCtl prob: NEW %s \n",k8s.k8sNP_NEW)

		k8s.Graph.Lock()

		for !(k8s.k8sNP_OLD[old].from == "" && k8s.k8sNP_NEW[new].from == "") {
			logging.GetLogger().Debugf("k8s.k8sNP_OLD[old].from = %s \n k8s.k8sNP_OLD[old].to = %s \n k8s.k8sNP_NEW[new].from = %s \n k8s.k8sNP_NEW[new].to = %s\n",k8s.k8sNP_OLD[old].from, k8s.k8sNP_OLD[old].to,k8s.k8sNP_NEW[new].from,k8s.k8sNP_NEW[new].to)

			if (k8s.k8sNP_OLD[old].from == "" && k8s.k8sNP_NEW[new].from != "" &&  k8s.k8sNP_NEW[new].to != ""){
				// add new
				ID := k8s.AddNPEdge(k8s.k8sNP_NEW[new])
				k8s.k8sNP_NEW[new].e = ID
				new ++

			}else if (k8s.k8sNP_OLD[old].from != "" &&  k8s.k8sNP_OLD[old].to != "" && k8s.k8sNP_NEW[new].from == "" ){
				// remove old
				logging.GetLogger().Debugf("Remove Link %s to %s %s (%s)\n", k8s.k8sNP_OLD[old].fromStr, k8s.k8sNP_OLD[old].toStr, k8s.k8sNP_OLD[old].direction, k8s.k8sNP_OLD[old].npText)
				edge := k8s.Graph.GetEdge(k8s.k8sNP_OLD[old].e)
				if edge == nil {
					logging.GetLogger().Debugf("Failed to Get Edge ID %s \n",k8s.k8sNP_OLD[old].e)
				}else{
					k8s.Graph.DelEdge(edge)
				}
				old++
			}else {

				l := k8s.ComapreNP(k8s.k8sNP_OLD[old], k8s.k8sNP_NEW[new])

				if (l == 2) {
					old++
					new++
				} else if (l == 1) {
					// update
					k8s.Graph.SetMetadata(k8s.k8sNP_NEW[new].e, k8s.k8sNP_NEW[new].m)
					new++
					old++
				} else if (l == 0) {
					if (k8s.k8sNP_OLD[old].fromStr < k8s.k8sNP_NEW[new].fromStr) {
						// new to be add
						ID := k8s.AddNPEdge(k8s.k8sNP_NEW[new])
						k8s.k8sNP_NEW[new].e = ID
						new++
					} else {
						// old to be remove
						logging.GetLogger().Debugf("Remove Link %s to %s %s (%s)\n", k8s.k8sNP_OLD[old].fromStr, k8s.k8sNP_OLD[old].toStr, k8s.k8sNP_OLD[old].direction, k8s.k8sNP_OLD[old].npText)
						logging.GetLogger().Debugf("Remove Edge %s \n", k8s.k8sNP_OLD[old].e)
						edge := k8s.Graph.GetEdge(k8s.k8sNP_OLD[old].e)
						if edge == nil {
							logging.GetLogger().Debugf("Failed to Get Edge ID %s \n",k8s.k8sNP_OLD[old].e)
						}else {
							k8s.Graph.DelEdge(edge)
						}
						old++
					}
				}
			}
		}
		k8s.Graph.Unlock()
	}
}

// Add Link procedure
func (k8s *K8SCtlProbe) AddNPEdge(np k8sNP) graph.Identifier {
	logging.GetLogger().Debugf("Attempt to Add Link %s to %s %s (%s)\n", np.fromStr, np.toStr, np.direction, np.npText)

	fromNode := k8s.Graph.GetNode(np.from)
	if fromNode==nil{
		logging.GetLogger().Debugf("Failed to Add From Edge Node ID %s \n",np.from)
	}

	toNode := k8s.Graph.GetNode(np.to)
	if toNode==nil{
		logging.GetLogger().Debugf("Failed to Add To Edge Node ID %s \n",np.to)
	}

	if (fromNode!=nil && toNode!=nil){
		_, ID := k8s.Graph.Link(fromNode, toNode, np.m)
		logging.GetLogger().Debugf("Added Edge %s \n",np.e)
		return ID
	}else{
		logging.GetLogger().Debugf("Failed to Add NS Edge \n")
		return ""
	}

}

// compare k8s np: 0 - not equal at all, 1 - ONLY from-to are equal, 2 - ALL equal
func (k8s *K8SCtlProbe) ComapreNP(old k8sNP, new k8sNP) int {
	if (old.from == new.from && old.to == new.to){
		if (old.m["NetworkPolicy"] == new.m["NetworkPolicy"] && old.m["Direction"] == new.m["Direction"]) {
			return 2
		}else{
			return 1
		}
	} else {
		return 0
	}
}

// gets network policies from k8s
func (k8s *K8SCtlProbe) Getk8sNP(){

	// uses the current context in kubeconfig
	kubeconfig := config.GetConfig().GetString("k8s.config_file")
	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		panic(err.Error())
	}
	// creates the clientset
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		panic(err.Error())
	}

	// get name spaces
	nss, err := clientset.CoreV1().Namespaces().List(v1.ListOptions{})
	if err != nil {
		panic(err.Error())
	}

	var i int = 0
	for _, ns := range nss.Items {

		var deny bool = false
		// get ns annotations
		if len(ns.Annotations) > 0{
			for _,v := range ns.Annotations {
				if v=="{\"ingress\":{\"isolation\":\"DefaultDeny\"}}" {
					logging.GetLogger().Debugf("\t\t DefaultDeny\n")
					deny = true
				}
			}
		}

		// get network policies
		nps, err := clientset.ExtensionsV1beta1().NetworkPolicies(ns.GetName()).List(v1.ListOptions{})
		if err != nil {
			logging.GetLogger().Debugf("Error: "+err.Error())
		}
		logging.GetLogger().Debugf("%s ns: There are %d network policies in the cluster\n\n", ns.GetName(),len(nps.Items))

		for _, np := range nps.Items {

			var npText string = ""
			var FromPod []k8sPodEdge
			var ToPod []k8sPodEdge
			for ingress := range np.Spec.Ingress {
				// Assuming that only single descriptor is used to choose the "From" np
				for from := range np.Spec.Ingress[ingress].From {
					PodSelectorLabels := np.Spec.Ingress[ingress].From[from].PodSelector
					if (PodSelectorLabels != nil) {

						for key, value := range  PodSelectorLabels.MatchLabels {
							id := k8s.FindPodByLabel(key,value,"")
							if id.Valid{
								FromPod = append(FromPod, id)
							}
						}
						//for key, value := range  PodSelectorLabels.MatchExpressions {
							// TODO
							//logging.GetLogger().Debugf("\t\tPodSelector MatchExpressions (k/v) - %s: %s\n",key,value)
						//}
						break
					}

					NamespaceSelectorLabels := np.Spec.Ingress[ingress].From[from].NamespaceSelector
					if (NamespaceSelectorLabels != nil) {
						for _, value := range  NamespaceSelectorLabels.MatchLabels {
							// assume that key/value for ns are actually the namespace name itself
							valid, id := k8s.FindPodByNS(value)
							if valid{
								FromPod = id
							}
						}
						//for key, value := range  NamespaceSelectorLabels.MatchExpressions {
						//	logging.GetLogger().Debugf("\t\tNamespaceSelector MatchExpressions (k/v) - %s: %s\n",key,value)
						//}
						break
					}
				}

				if len(np.Spec.Ingress[ingress].Ports)>0 {

					for port := range np.Spec.Ingress[ingress].Ports {
						ProtocolStr := valueToStringGenerated(np.Spec.Ingress[ingress].Ports[port].Protocol)
						npText = fmt.Sprintf("%s %s/%s ",npText, ProtocolStr, np.Spec.Ingress[ingress].Ports[port].Port)
					}
				}
			}

			if len(np.Spec.PodSelector.MatchLabels)>0 {
				for key, value := range  np.Spec.PodSelector.MatchLabels {
					id := k8s.FindPodByLabel(key,value,ns.GetName())
					if id.Valid{
						ToPod = append(ToPod, id)
					}
				}
				//for key, value := range  np.Spec.PodSelector.MatchExpressions {
					//logging.GetLogger().Debugf("\t\tPodSelector MatchExpressions (k/v) - %s: %s\n",key,value)
					// TODO
				//}
			} else {
				//choose all pods in the given ns
				valid, pod := k8s.FindPodByNS(ns.GetName())
				if valid{
					ToPod = pod
				}

			}

			// build the np edge - skip if not deny - to avoid system ns which allows all-to-all communication between their pods
			if deny {
				for _,fromp := range FromPod {
					for _,top := range ToPod {
						logging.GetLogger().Debugf("fromp.GraphNode = %s  top.GraphNode = %s \n", fromp.GraphNode, top.GraphNode)
						if ((fromp.GraphNode != "") && (top.GraphNode != "")) {
							var direction string ="->"
							if strings.Compare(npText,"") != 0 {
								npText = fmt.Sprintf("ingress: %s ",npText)
							}

							m := graph.Metadata{"Application": "k8s", "RelationType": "applink", "LinkType": "k8s policy", "NetworkPolicy": npText, "Direction": direction, "From": fromp.Name, "To": top.Name}

							var NS k8sNP
							NS.from = fromp.GraphNode
							NS.to = top.GraphNode
							NS.m = m
							NS.fromStr = fromp.Name
							NS.toStr = top.Name
							NS.direction = direction
							NS.npText = npText
							k8s.k8sNP_NEW[i] = NS
							i = i+1
							logging.GetLogger().Debugf("New NP has been added to k8s.k8sNP_NEW\n")
						}
					}
				}

			}
		}
	}
}



func (k8s *K8SCtlProbe) OnNodeUpdated(n *graph.Node) {

}

func (k8s *K8SCtlProbe) OnNodeAdded(n *graph.Node) {

}

func (k8s *K8SCtlProbe) OnNodeDeleted(n *graph.Node) {
}

func (k8s *K8SCtlProbe) OnEdgeUpdated(e *graph.Edge) {
}

func (k8s *K8SCtlProbe) OnEdgeAdded(e *graph.Edge) {
}

func (k8s *K8SCtlProbe) OnEdgeDeleted(e *graph.Edge) {
}

func (k8s *K8SCtlProbe) Start() {
	logging.GetLogger().Debugf("k8s prob: got command - %s", "Start")
	logging.GetLogger().Debugf("k8s prob: Host is: %s\n",k8s.Graph.GetHost())
	if (k8s.Graph.GetHost() == config.GetConfig().GetString("k8s.host_ctl")){
		logging.GetLogger().Debugf("k8s prob: Running k8sctl \n")
		go k8s.messagesUpdater()
		go k8s.Updatek8sNP()
	}
}

func (k8s *K8SCtlProbe) Run() {
	logging.GetLogger().Debugf("k8s prob: got command - %s", "Run")
}

func (k8s *K8SCtlProbe) Stop() {
	k8s.Graph.RemoveEventListener(k8s)
	close(k8s.nodeUpdaterChan)
	close(k8s.messagesUpdaterChan)
	logging.GetLogger().Debugf("k8s prob: got command - %s", "Stop")
}

func (k8s *K8SCtlProbe) messagesUpdater() {
	logging.GetLogger().Debugf("k8s prob: Starting messages updater")
	for message := range k8s.messagesUpdaterChan {
		k8s.MessageFromUpdater(message.msgType, message.obj)
	}
	logging.GetLogger().Debugf("k8s prob: Stopping messages updater")
}

func (k8s *K8SCtlProbe) OnMessage(msgType string, obj interface{}) {
	k8s.messagesUpdaterChan <- K8SCtlMessage{msgType, obj}
}

func (k8s *K8SCtlProbe) MessageFromUpdater(msgType string, obj interface{}) {
	logging.GetLogger().Debugf("Received msgType from updater: %s ", msgType)
	switch msgType {

	case "NodeAdded":
		n := obj.(*graph.Node)
		nodeType := n.Metadata()["Type"]
		nodeName := n.Metadata()["Name"]
		nodeID := n.ID

		if nodeType =="netns" {
			logging.GetLogger().Debugf("k8s prob: Node Name/Type %s / %s  \n", nodeName, nodeType)
			k8s.NetnsIDs[nodeName] = nodeID
			logging.GetLogger().Debugf("Adding new node with ID [%s]", n.ID)
			k8s.Graph.Lock()
			success := k8s.Graph.AddNode(n)
			if !success {
				logging.GetLogger().Debugf("Failed adding node with ID [%s]", n.ID)
			}
			k8s.Graph.Unlock()
		}
	}

}

func NewK8SCtlProbe(g *graph.Graph, r *graph.Receiver) *K8SCtlProbe {
	logging.GetLogger().Debugf("k8sCtl prob: got command - %s", "NewK8SCtlProbe")
	k8s := &K8SCtlProbe{
		Graph: g,
	}

	k8s.nodeUpdaterChan = make(chan graph.Identifier, 500)
	k8s.messagesUpdaterChan = make(chan K8SCtlMessage, 500)
	k8s.NetnsIDs = make(map[interface{}]graph.Identifier)
	k8s.k8sPods = make(map[string]k8sPodsStruct)
	k8s.k8sNP_OLD = make([]k8sNP, 50) //TODO: increase size?
	k8s.k8sNP_NEW = make([]k8sNP, 50) //TODO: increase size?
	g.AddEventListener(k8s)
	r.AddEventListener(k8s)
	return k8s
}
