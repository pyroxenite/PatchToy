# TODO
 - Camera may be broken
 - Feedback node may be broken
 - Swizzles sometimes don't have an effect on the produced GLSL code (check if it's still the case)
 - Fullscreen works but it matches the size of the window and not the size of the screen
 - Save button disappears 
 - More uniforms:
   - Midi
   - BPM tracking?
   - Frequency bands
   - XY controller 
   - Keyboard
 - More modules:
   - Basic transforms
 - Website Icon
 - Initial preview node resolution bug
 - GLSL code editor size, position, visibility states should be saved to project
 - GLSL code editor should close when switching projects
 - Key command to toggle fps view
 - Dirty editors aren't preserved
  
# Big features
  - User settings, project settings, display settings
  - JS computation nodes for more complex scenarios
    - Manipulate more complexe objects on the CPU side
    - Run simulations etc...
    - Must output to uniforms
    - Either a new type of uniform node or a new type of connection with a JS value to uniform adaptor
  - Better project management (almost done but local auto saving is broken)
  - 
  - User profile view, project thumbnails  
  - Custom UI (current UI is boring, buggy, not always practical)
    - Pixel art would be fire but requires some sort of mini custom canvas UI lib
    - Titles currently are inconsistent
    - Special node style for uniforms
  - Node groups (should support groups of groups too)
    - Two types of groups:
      - Simple groups, just visual simplifications
      - Custom node groups: they define a new type of node and sync changes across all nodes that share the node group definition
  - Multi input mixing
    - Optionnal lazy evaluation for inputs that require high computation
  - For loops ?
    - UI: 
      - resizeable width to accomodate a variable amount of inner/nested nodes
      - shape: -----------------------------------------
               | iterations  |---------| break         |
               | outin inout |         | inin1 outout1 |
               | outin inout |         | inin2 outout2 |
               ---------------         -----------------

      - shape: -----------------
               | iterations    |
               | break         |
               | start1 inter1 |
               | start2 inter2 |
               | start3 inter3 |
               | inter1   end1 |
               | inter2   end2 |
               | inter3   end3 |
               -----------------
    - Outer ports
      - Inputs: 
        - Initialize iteration variables
        - Define number of iterations
      - Outputs: Return iteration variables
    - Inner ports
      - Outputs: Return current iteration variables
      - Inputs: 
        - Accept modified iteration variables
        - Allow breaking
