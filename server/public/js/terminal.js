document.getElementById('startCameraButton').addEventListener('click', () => {
    socket.emit('robot:camera:start', {})
})