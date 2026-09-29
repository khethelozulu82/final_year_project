import json
from channels.generic.websocket import AsyncWebsocketConsumer


class FleetTrackingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.channel_layer.group_add("fleet_tracking", self.channel_name)
        await self.accept()
        await self.send(text_data=json.dumps({"type": "connected", "channel": "fleet"}))

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard("fleet_tracking", self.channel_name)

    async def fleet_update(self, event):
        await self.send(text_data=json.dumps({"type": "fleet.update", "payload": event["payload"]}))

    async def panic_alert(self, event):
        await self.send(text_data=json.dumps({"type": "panic.alert", "payload": event["payload"]}))


class TripTrackingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.trip_id = self.scope["url_route"]["kwargs"]["trip_id"]
        self.group = f"trip_{self.trip_id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()
        await self.send(
            text_data=json.dumps({"type": "connected", "channel": "trip", "trip_id": self.trip_id})
        )

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.group, self.channel_name)

    async def trip_location(self, event):
        await self.send(text_data=json.dumps({"type": "trip.location", "payload": event["payload"]}))