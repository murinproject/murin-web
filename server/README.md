
```
Socket.IO
├── /robot
│     rooms
│       robot:murin-01
│       robot:murin-02
│
│     events
│       cmd_vel
│       goal
│       telemetry
│       odom
│       battery
│       mode
│
├── /media
│     rooms
│       robot:murin-01
│       camera:front
│       camera:rear
│
│     events
│       frame
│       snapshot
│
├── /system
│     events
│       notification
│       update
│       heartbeat
│
├── /debug
│     events
│       log
│       trace
│       metrics
│
└── /admin
      events
        login
        user
        permission
```