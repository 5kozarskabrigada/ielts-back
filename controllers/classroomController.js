import { supabase } from "../supabaseClient.js";

// List all classrooms
export const listClassrooms = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("classrooms")
      .select("*, students:classroom_students(count)")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Create a new classroom
export const createClassroom = async (req, res) => {
  const { name, description } = req.body;
  const createdBy = req.user?.id || null;

  if (!name) {
    return res.status(400).json({ error: "Classroom name is required" });
  }

  try {
    const insertData = { 
      name, 
      description: description || null
    };
    
    // Only add created_by if we have a valid user ID
    if (createdBy) {
      insertData.created_by = createdBy;
    }

    const { data, error } = await supabase
      .from("classrooms")
      .insert([insertData])
      .select()
      .single();

    if (error) {
      console.error("Create Classroom DB Error:", error);
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error("Create Classroom Error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Add student to classroom
export const addStudentToClassroom = async (req, res) => {
  const { id } = req.params; // classroomId
  const { studentId } = req.body;

  try {
    const { data, error } = await supabase
      .from("classroom_students")
      .insert([{ classroom_id: id, student_id: studentId }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') { // Unique violation
        return res.status(409).json({ error: "Student already in classroom" });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Remove student from classroom
export const removeStudentFromClassroom = async (req, res) => {
  const { id, studentId } = req.params;

  try {
    const { error } = await supabase
      .from("classroom_students")
      .delete()
      .eq("classroom_id", id)
      .eq("student_id", studentId);

    if (error) throw error;
    res.json({ message: "Student removed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get classroom details with students
export const getClassroom = async (req, res) => {
  const { id } = req.params;

  try {
    const { data: classroom, error: classError } = await supabase
      .from("classrooms")
      .select("*")
      .eq("id", id)
      .single();

    if (classError) throw classError;

    const { data: students, error: studentError } = await supabase
      .from("classroom_students")
      .select("student_id, user:users(id, first_name, last_name, email, username)")
      .eq("classroom_id", id);

    if (studentError) throw studentError;

    res.json({ ...classroom, students: students.map(s => s.user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update a classroom
export const updateClassroom = async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Classroom name is required" });
  }

  try {
    const { data, error } = await supabase
      .from("classrooms")
      .update({ name, description: description || null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Delete a classroom
export const deleteClassroom = async (req, res) => {
  const { id } = req.params;

  try {
    // First delete all student associations
    const { error: studentError } = await supabase
      .from("classroom_students")
      .delete()
      .eq("classroom_id", id);

    if (studentError) throw studentError;

    // Then delete the classroom
    const { error } = await supabase
      .from("classrooms")
      .delete()
      .eq("id", id);

    if (error) throw error;
    res.json({ message: "Classroom deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
