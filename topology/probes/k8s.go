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
	"github.com/skydive-project/skydive/logging"
	"github.com/skydive-project/skydive/topology/graph"
	"github.com/skydive-project/skydive/config"

	"github.com/FlorianOtel/client-go/kubernetes"
	"github.com/FlorianOtel/client-go/pkg/api/v1"
	"github.com/FlorianOtel/client-go/tools/clientcmd"
	"github.com/FlorianOtel/client-go/pkg/types"
	"strings"
)

type K8SMessage struct {
	msgType string
	obj     interface{}
}


type K8SProbe struct {
	Graph           *graph.Graph
	nodeUpdaterChan chan graph.Identifier
	messagesUpdaterChan chan K8SMessage
	uid 		[]types.UID
}

// sync between pods (k8s.k8sPods) as reported by k8s and skydive netns IDs (k8s.NetnsIDs)
func (k8s *K8SProbe) isK8S(nodeName string) bool {
	for _,uid := range k8s.uid{
		// match name with nodeName
		logging.GetLogger().Debugf("Compare nodeName %s with uid %s \n", nodeName, string(uid))
		if strings.Contains(nodeName, string(uid)) {
			// update k8sPods
			logging.GetLogger().Debugf("Found match! nodeName %s with uid %s \n", nodeName, string(uid))
			return true
		}
	}
	logging.GetLogger().Debugf("No match is found for nodeName %s \n", nodeName)
	return false

}

// gets pods from k8s
func (k8s *K8SProbe) Getk8sPods() {
	kubeconfig := config.GetConfig().GetString("k8s.config_file")
	// uses the current context in kubeconfig
	logging.GetLogger().Debugf("kubeconfig: %s \n", kubeconfig)
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



	for _, pod := range pods.Items {
		logging.GetLogger().Debugf("%s %s %s\n", pod.GetName(), pod.GetCreationTimestamp(), pod.GetUID())
		isExist := k8s.isUIDExist(pod.GetUID())
		if !isExist{
			k8s.uid = append(k8s.uid, pod.GetUID())
		}

	}
	logging.GetLogger().Debugf("uid list: %s \n", k8s.uid)
}


func (k8s *K8SProbe) isUIDExist(uid types.UID) bool {
	for _,u := range k8s.uid{
		if u==uid{
			return true
		}
	}
	return false
}


func (k8s *K8SProbe) EnhanceNode(id graph.Identifier){
	n := k8s.Graph.GetNode(id)
	if  n==nil {
		logging.GetLogger().Debugf("WARNING: Cannot Find Node %s \n",id)
	} else {
		nodeProb := n.Metadata()["Probe"]
		nodeType := n.Metadata()["Type"]
		nodeName := n.Metadata()["Name"]

		if nodeType == "netns" {
			logging.GetLogger().Debugf("Node Added/(Updated): %s/%s n", n.Metadata()["Name"], n.Metadata()["Type"])
			k8s.Getk8sPods()
			isk8s := k8s.isK8S(nodeName.(string))
			if isk8s {
				logging.GetLogger().Debugf("NetNS node: %s / %s /%s \n", nodeProb, nodeType, nodeName)
				k8s.Graph.Lock()
				k8s.Graph.AddMetadata(n, "Orchestrator", "k8s")
				k8s.Graph.AddMetadata(n, "Kind", "Pod")
				k8s.Graph.Unlock()
			}
		}
	}
}

func (k8s *K8SProbe) OnNodeUpdated(n *graph.Node) {
	k8s.nodeUpdaterChan <- n.ID
}

func (k8s *K8SProbe) OnNodeAdded(n *graph.Node) {
	k8s.nodeUpdaterChan <- n.ID
}

func (k8s *K8SProbe) OnNodeDeleted(n *graph.Node) {
}

func (k8s *K8SProbe) OnEdgeUpdated(e *graph.Edge) {
}

func (k8s *K8SProbe) OnEdgeAdded(e *graph.Edge) {
}

func (k8s *K8SProbe) OnEdgeDeleted(e *graph.Edge) {
}

func (k8s *K8SProbe) nodeMessagesUpdater() {
	logging.GetLogger().Debugf("k8s prob: Starting messages updater")
	for message := range k8s.nodeUpdaterChan {
		k8s.EnhanceNode(message)
	}
	logging.GetLogger().Debugf("k8s prob: Stopping messages updater")
}

func (k8s *K8SProbe) Start() {
	logging.GetLogger().Debugf("k8s prob: got command - %s", "Start")
	go k8s.nodeMessagesUpdater()
	go k8s.messagesUpdater()
}

func (k8s *K8SProbe) Run() {
	logging.GetLogger().Debugf("k8s prob: got command - %s", "Run")
}

func (k8s *K8SProbe) Stop() {
	k8s.Graph.RemoveEventListener(k8s)
	close(k8s.nodeUpdaterChan)
	close(k8s.messagesUpdaterChan)
	logging.GetLogger().Debugf("k8s prob: got command - %s", "Stop")
}

func (k8s *K8SProbe) messagesUpdater() {
	logging.GetLogger().Debugf("k8s prob: Starting messages updater")
	for message := range k8s.messagesUpdaterChan {
		k8s.MessageFromUpdater(message.msgType, message.obj)
	}
	logging.GetLogger().Debugf("k8s prob: Stopping messages updater")
}

func (k8s *K8SProbe) OnMessage(msgType string, obj interface{}) {
	k8s.messagesUpdaterChan <- K8SMessage{msgType, obj}
}

func (k8s *K8SProbe) MessageFromUpdater(msgType string, obj interface{}) {
	if (k8s.Graph.GetHost() != config.GetConfig().GetString("k8s.host_ctl")) {

		logging.GetLogger().Debugf("Received msgType from updater: %s ", msgType)
		switch msgType {
		case "EdgeDeleted":
			e := obj.(*graph.Edge)
			k8s.Graph.Lock()
			k8s.Graph.DelEdge(e)
			k8s.Graph.Unlock()

		case "EdgeAdded":
			e := obj.(*graph.Edge)
			k8s.Graph.Lock()
			k8s.Graph.AddEdge(e)
			k8s.Graph.Unlock()

		//case "NodeUpdated", "NodeAdded":
		case "NodeAdded", "NodeUpdated":
			n := obj.(*graph.Node)
			nodeType := n.Metadata()["Type"]
			nodeName := n.Metadata()["Name"]

			if nodeType == "netns" {
				logging.GetLogger().Debugf("k8s prob: Node Name/Type %s / %s  \n", nodeName, nodeType)
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
}



func NewK8SProbe(g *graph.Graph, r *graph.Receiver) *K8SProbe {
	logging.GetLogger().Debugf("k8s prob: got command - %s", "NewK8SProbe")
	k8s := &K8SProbe{
		Graph: g,
	}
	k8s.messagesUpdaterChan = make(chan K8SMessage, 500)
	k8s.nodeUpdaterChan = make(chan graph.Identifier, 500)
	g.AddEventListener(k8s)
	r.AddEventListener(k8s)
	return k8s
}