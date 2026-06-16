# Heli-Strike Arcade Assault

![Gameplay](playtest-polished-action-1280x720.png)

A fast-paced, 3D low-poly arcade helicopter shooter built with React, Vite, Three.js, and Cannon-es. Survive endless waves of enemies, collect power-ups, and rack up high scores!

## Features

- **Intense 3D Action**: Fly a military helicopter over procedurally generated cities, deserts, and forests.
- **Multiple Weapons**: Switch between Machine Guns, Missiles, Rockets, and Shotguns to obliterate your enemies.
- **Dynamic AI**: Face off against drones, tanks, shooters, and boss enemies that actively track and attack you.
- **Power-Up System**: Fly over defeated enemies to collect Health, Fuel, Ammo, Damage Boosts, Shields, Speed Boosts, and Screen-clearing Bombs!
- **Weather & Physics**: Experience thunderstorms, rain, and realistic rigid-body physics for explosive combat.

## Screenshots

### Main Menu
![Main Menu](playtest-polished-menu-1280x720.png)

### High-Octane Combat
![Action](playtest-action-1280x720.png)

## How to Run Locally

**Prerequisites:** Node.js v20+

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```

## Controls

- **W, A, S, D / Arrows**: Move Helicopter
- **Mouse**: Aim crosshair
- **Left Click**: Fire weapon
- **Q / Right Click**: Lock-on Multi-Salvo
- **Space / Alt**: Special Abilities
- **1, 2, 3, 4**: Switch weapons (Machine Gun, Missile, Rocket, Shotgun)
- **R**: Reload
- **Esc / P**: Pause (opens in-game settings)

## Settings

Open the **Settings** panel from the main menu, or pause mid-run with **Esc / P**, to adjust:

- **Master Volume** and **Mute**
- **Invert Aim Y**
- **High Quality (Bloom)** post-processing

All settings and your lifetime stats (runs played, best wave, best combo) are saved locally in your browser.
