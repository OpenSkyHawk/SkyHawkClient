import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/saira/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
