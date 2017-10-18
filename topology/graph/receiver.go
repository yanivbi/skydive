/*
 * Copyright (C) 2015 Red Hat, Inc.
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

package graph

import (
	"sync"

	shttp "github.com/skydive-project/skydive/http"
	"github.com/skydive-project/skydive/logging"
)


type ReceiverEventListener interface {
	OnMessage(string, interface{})
}

type receiverEventListenerStack []ReceiverEventListener

type Receiver struct {
	sync.RWMutex
	eventListeners     []ReceiverEventListener
	eventListenerStack receiverEventListenerStack
	pool               shttp.WSJSONSpeakerPool
}

func (s *receiverEventListenerStack) push(l ReceiverEventListener) {
	*s = append(*s, l)
}

func (s *receiverEventListenerStack) pop() ReceiverEventListener {
	if len(*s) == 0 {
		return nil
	}

	l := (*s)[len(*s)-1]
	*s = (*s)[:len(*s)-1]

	return l
}

func (r *Receiver) AddEventListener(l ReceiverEventListener) {
	r.Lock()
	defer r.Unlock()

	r.eventListeners = append(r.eventListeners, l)
}

func (r *Receiver) RemoveEventListener(l ReceiverEventListener) {
	r.Lock()
	defer r.Unlock()

	for i, el := range r.eventListeners {
		if l == el {
			r.eventListeners = append(r.eventListeners[:i], r.eventListeners[i+1:]...)
			break
		}
	}
}

func (r *Receiver) OnWSJSONMessage(c shttp.WSSpeaker, msg *shttp.WSJSONMessage) {

	msgType, obj, err := UnmarshalWSMessage(msg)
	if err != nil {
		logging.GetLogger().Errorf("Receiver: Unable to parse message type %s error %s", msg.Type, err.Error())
		return
	}

	if  msgType == shttp.BulkMsgType {
		logging.GetLogger().Errorf("Receiver: Unable to parse message type %s ", msg.Type)
	} else {
		r.NotifyAllOnMessage(msgType, obj)
	}
}

func (r *Receiver) NotifyAllOnMessage(msgType string, obj interface{}) {
    for _, l := range r.eventListeners {
       r.eventListenerStack.push(l)
       l.OnMessage(msgType, obj)
       r.eventListenerStack.pop()
    }
}

func NewReceiver(graph *Graph, pool shttp.WSJSONSpeakerPool) *Receiver {
	var r *Receiver

	if pool != nil {
		r = &Receiver{pool: pool}
		pool.AddJSONMessageHandler(r, []string{Namespace})
	} else {
		logging.GetLogger().Errorf("Can't create Receiver, no WSAsyncClient supplied\n")
	}
	return r
}
